/**
 * Slack 通知モジュール
 *
 * ブラックリストに新規追加されたエントリを Slack に通知する。
 * Blacklist シートの D 列（notified）を使って未通知エントリを管理する。
 *
 * シート構造（拡張後）:
 * | A: email | B: added_date | C: source | D: notified |
 *
 * Slack ファイルアップロードは Files API v2（3ステップ）を使用:
 * 1. files.getUploadURLExternal でアップロード URL と file_id を取得
 * 2. 取得した URL に CSV をアップロード
 * 3. files.completeUploadExternal でチャンネルへの投稿を完了
 *
 * Script Properties:
 * - SLACK_BOT_TOKEN: Slack Bot Token（xoxb-...）
 * - SLACK_CHANNEL_ID: 通知先チャンネル ID
 */

/**
 * ブラックリスト新規追加エントリを Slack に通知するメイン関数
 * GAS トリガーから呼び出される。
 * 未通知エントリがない場合は早期リターンする。
 * エラーが発生してもスローせず、ログに記録するのみ。
 */
function notifyNewBlacklistEntries() {
  if (!CONFIG.SLACK_NOTIFY_ENABLED) {
    return;
  }

  try {
    const entries = getUnnotifiedBlacklistEntries_();
    if (entries.length === 0) {
      return;
    }

    console.log('未通知のブラックリストエントリ数:', entries.length);

    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    const filename = 'blacklist_' + today + '.txt';
    const csvContent = buildBlacklistCsv_(entries);
    const message = buildSlackMessage_(entries);

    uploadCsvToSlack_(csvContent, filename, message);

    const rows = entries.map(function(entry) { return entry.row; });
    markAsNotified_(rows);

    console.log('Slack 通知完了。通知済みエントリ数:', entries.length);
  } catch (e) {
    console.error('Slack 通知に失敗:', e.message);
  }
}

/**
 * Blacklist シートから未通知のエントリを取得する
 * D 列（index 3）が空のエントリを未通知とみなす。
 * D1 ヘッダーが空の場合は後方互換性のため "notified" を書き込む。
 * @returns {Array<{ email: string, addedDate: string, source: string, row: number }>}
 * @private
 */
function getUnnotifiedBlacklistEntries_() {
  const sheet = getBlacklistSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return [];
  }

  // D1 ヘッダーが未設定の場合、後方互換性のために書き込む
  const d1Value = sheet.getRange(1, 4).getValue();
  if (!d1Value) {
    sheet.getRange(1, 4).setValue('notified');
  }

  // 2行目以降の全データを取得（A〜D列）
  const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  const unnotified = [];

  for (let i = 0; i < data.length; i++) {
    const email = String(data[i][0]);
    if (!email) continue;

    const notifiedValue = data[i][3]; // D列
    if (notifiedValue === '' || notifiedValue === null || notifiedValue === undefined) {
      unnotified.push({
        email: email,
        addedDate: String(data[i][1]),
        source: String(data[i][2]),
        row: i + 2, // ヘッダー行分 + 0始まりインデックス分
      });
    }
  }

  return unnotified;
}

/**
 * エントリ配列からメールアドレスのみのテキストを生成する
 * Admin Console「一括追加」テキストエリアにそのまま貼り付け可能な形式。
 * ヘッダーなし、1行1アドレス。
 * @param {Array<{ email: string, addedDate: string, source: string, row: number }>} entries
 * @returns {string} メールアドレス一覧テキスト
 * @private
 */
function buildBlacklistCsv_(entries) {
  return entries.map(function(entry) { return entry.email; }).join('\n');
}

/**
 * Slack への投稿メッセージ本文を生成する
 * @param {Array<{ email: string, addedDate: string, source: string, row: number }>} entries
 * @returns {string} メッセージ本文
 * @private
 */
function buildSlackMessage_(entries) {
  const emails = entries.map(function(entry) { return entry.email; }).join(', ');
  return ':no_entry: ブラックリスト新規追加通知\n\n' +
    '件数: ' + entries.length + '件\n' +
    '追加元: auto（AI自動判定）\n\n' +
    '```\n' + emails + '\n```\n' +
    ':arrow_right: Admin Console に登録:\n' +
    'https://admin.google.com/ → アプリ → Google Workspace → Gmail → 迷惑メール、フィッシング、マルウェア → ブロックされている送信者 → 一括追加';
}

/**
 * CSV ファイルを Slack にアップロードしてチャンネルに投稿する
 * Files API v2 の 3 ステップアップロードを使用する。
 * @param {string} csvContent - CSV 文字列
 * @param {string} filename - アップロードするファイル名
 * @param {string} message - 投稿メッセージ（initial_comment）
 * @private
 */
function uploadCsvToSlack_(csvContent, filename, message) {
  const props = PropertiesService.getScriptProperties();
  const channelId = props.getProperty('SLACK_CHANNEL_ID');
  if (!channelId) {
    throw new Error('Script Property "SLACK_CHANNEL_ID" が設定されていません');
  }

  const csvBlob = Utilities.newBlob(csvContent, 'text/plain', filename);
  const csvBytes = csvBlob.getBytes();
  const fileLength = csvBytes.length;

  // Step 1: アップロード URL と file_id を取得
  console.log('Slack: アップロード URL を取得中...');
  const urlResponse = slackApiRequest_('/files.getUploadURLExternal', {
    method: 'post',
    payload: {
      filename: filename,
      length: String(fileLength),
    },
  });

  if (!urlResponse.ok) {
    throw new Error('files.getUploadURLExternal 失敗: ' + JSON.stringify(urlResponse));
  }

  const uploadUrl = urlResponse.upload_url;
  const fileId = urlResponse.file_id;
  console.log('Slack: file_id =', fileId);

  // Step 2: 取得した URL に CSV を直接アップロード（認証ヘッダー不要）
  console.log('Slack: CSV をアップロード中...');
  const uploadResponse = UrlFetchApp.fetch(uploadUrl, {
    method: 'post',
    payload: csvBlob,
    muteHttpExceptions: true,
  });
  const uploadCode = uploadResponse.getResponseCode();
  if (uploadCode < 200 || uploadCode >= 300) {
    throw new Error(
      'CSV アップロード失敗: ' + uploadCode + ' ' + uploadResponse.getContentText()
    );
  }

  // Step 3: アップロード完了・チャンネルへ投稿
  console.log('Slack: アップロードを完了し、チャンネルに投稿中...');
  const completeResponse = slackApiRequest_('/files.completeUploadExternal', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      files: [{ id: fileId, title: filename }],
      channel_id: channelId,
      initial_comment: message,
    }),
  });

  if (!completeResponse.ok) {
    throw new Error('files.completeUploadExternal 失敗: ' + JSON.stringify(completeResponse));
  }

  console.log('Slack: ファイル投稿完了');
}

/**
 * Slack API への共通リクエスト関数
 * gmailApiRequest() のパターンに倣い、認証ヘッダーを付与して UrlFetchApp でリクエストを送る。
 * @param {string} endpoint - CONFIG.SLACK_API_BASE からの相対パス（例: '/files.getUploadURLExternal'）
 * @param {Object} [options={}] - UrlFetchApp.fetch に渡すオプション
 * @returns {Object} パース済みレスポンス
 * @throws {Error} API リクエスト失敗時
 * @private
 */
function slackApiRequest_(endpoint, options) {
  options = options || {};

  const token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) {
    throw new Error('Script Property "SLACK_BOT_TOKEN" が設定されていません');
  }

  const url = CONFIG.SLACK_API_BASE + endpoint;

  const defaultOptions = {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + token,
    },
    muteHttpExceptions: true,
  };

  const mergedOptions = Object.assign({}, defaultOptions, options);
  // headers をマージ（options.headers が指定された場合、Authorization を保持）
  mergedOptions.headers = Object.assign({}, defaultOptions.headers, options.headers || {});

  const response = UrlFetchApp.fetch(url, mergedOptions);
  const responseCode = response.getResponseCode();

  if (responseCode < 200 || responseCode >= 300) {
    throw new Error(
      'Slack API エラー: ' + responseCode + ' ' + response.getContentText() +
      ' (endpoint: ' + endpoint + ')'
    );
  }

  const content = response.getContentText();
  return content ? JSON.parse(content) : {};
}

/**
 * Blacklist シートの指定行の D 列（notified）に "TRUE" を書き込む
 * @param {number[]} rows - 更新対象の行番号（1始まり）の配列
 * @private
 */
function markAsNotified_(rows) {
  if (!rows || rows.length === 0) return;

  const sheet = getBlacklistSheet();
  for (let i = 0; i < rows.length; i++) {
    sheet.getRange(rows[i], 4).setValue('TRUE');
  }
  console.log('通知済みマーク完了。行数:', rows.length);
}
