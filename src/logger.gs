/**
 * 処理ログ記録
 *
 * Google Spreadsheet の「ProcessLog」シートに全処理結果を記録する。
 *
 * シート構造:
 * | A: timestamp | B: message_id | C: from | D: subject | E: classification | F: action | G: reason |
 *
 * 主な責務:
 * - ログ行の追記
 * - ヘッダー行の自動作成（シートが空の場合）
 * - バッチ書き込み（複数ログを一括で記録）
 */

/** @type {string[]} ログシートのヘッダー行 */
const LOG_HEADERS = ['timestamp', 'message_id', 'from', 'subject', 'classification', 'action', 'reason'];

/**
 * ログシートを取得する（存在しない場合は作成）
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getLogSheet() {
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  let sheet = ss.getSheetByName(CONFIG.LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.LOG_SHEET_NAME);
    sheet.appendRow(LOG_HEADERS);

    // ヘッダー行の書式設定
    const headerRange = sheet.getRange(1, 1, 1, LOG_HEADERS.length);
    headerRange.setBackground('#6aa84f');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
    headerRange.setHorizontalAlignment('center');

    // 1行目を固定
    sheet.setFrozenRows(1);

    // カラム幅の設定
    sheet.setColumnWidth(1, 170); // timestamp
    sheet.setColumnWidth(2, 130); // message_id
    sheet.setColumnWidth(3, 250); // from
    sheet.setColumnWidth(4, 300); // subject
    sheet.setColumnWidth(5, 120); // classification
    sheet.setColumnWidth(6, 180); // action
    sheet.setColumnWidth(7, 350); // reason

    // 折り返し設定（データ行: 2行目〜1001行目）
    sheet.getRange(2, 3, 1000, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP); // from
    sheet.getRange(2, 4, 1000, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP); // subject
    sheet.getRange(2, 7, 1000, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP); // reason
  }
  return sheet;
}

/**
 * @typedef {Object} ProcessingResult
 * @property {string} messageId - Gmail メッセージ ID
 * @property {string} from - 送信元メールアドレス
 * @property {string} subject - メール件名
 * @property {string} classification - 判定結果 (spam/legitimate/uncertain)
 * @property {string} action - 実行したアクション
 * @property {string} reason - 判定理由
 */

/**
 * 処理結果を1件ログに記録する
 * @param {ProcessingResult} result - 処理結果
 */
function logProcessingResult(result) {
  try {
    const sheet = getLogSheet();
    sheet.appendRow([
      formatDate(new Date()),
      result.messageId,
      result.from,
      result.subject,
      result.classification,
      result.action,
      result.reason,
    ]);
  } catch (e) {
    console.error('ログ記録エラー:', e);
  }
}

/**
 * 処理結果を一括でログに記録する
 * @param {ProcessingResult[]} results - 処理結果の配列
 */
function logBatchResults(results) {
  try {
    if (!results || results.length === 0) return;

    const sheet = getLogSheet();
    const now = formatDate(new Date());
    const rows = results.map((result) => [
      now,
      result.messageId,
      result.from,
      result.subject,
      result.classification,
      result.action,
      result.reason,
    ]);

    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, rows.length, LOG_HEADERS.length).setValues(rows);
  } catch (e) {
    console.error('バッチログ記録エラー:', e);
  }
}
