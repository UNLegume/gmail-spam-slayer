/**
 * ブラックリスト管理
 *
 * Google Spreadsheet の「Blacklist」シートを使ったブラックリスト管理。
 *
 * シート構造:
 * | A: email | B: added_date | C: last_confirmed_date | D: source (auto/manual) |
 *
 * 主な責務:
 * - ブラックリストの検索（メールアドレスが登録済みか確認）
 * - 猶予期間の判定（登録から30日以内か）
 * - エントリの追加（auto: AI判定による自動追加）
 * - エントリの削除（legitimate 判定による自動解除）
 * - last_confirmed_date の更新
 *
 * 猶予期間の仕様:
 * - 登録後30日間は AI 再判定を実施
 * - 猶予期間中に legitimate 判定 → 自動解除
 * - 猶予期間経過後 → API を呼ばず即アーカイブ
 */

/** @type {string[]} ブラックリストシートのヘッダー行 */
const BLACKLIST_HEADERS = ['email', 'added_date', 'last_confirmed_date', 'source'];

/**
 * ブラックリストシートを取得する（存在しない場合は作成）
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getBlacklistSheet() {
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  let sheet = ss.getSheetByName(CONFIG.BLACKLIST_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.BLACKLIST_SHEET_NAME);
    sheet.appendRow(BLACKLIST_HEADERS);

    // ヘッダー行の書式設定
    const headerRange = sheet.getRange(1, 1, 1, BLACKLIST_HEADERS.length);
    headerRange.setBackground('#4a86c8');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
    headerRange.setHorizontalAlignment('center');

    // 1行目を固定
    sheet.setFrozenRows(1);

    // カラム幅の設定
    sheet.setColumnWidth(1, 250); // email
    sheet.setColumnWidth(2, 130); // added_date
    sheet.setColumnWidth(3, 160); // last_confirmed_date
    sheet.setColumnWidth(4, 100); // source

    // 折り返し設定（データ行: 2行目〜1001行目）
    sheet.getRange(2, 1, 1000, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP); // email
  }
  return sheet;
}

/**
 * @typedef {Object} BlacklistEntry
 * @property {string} email - メールアドレス
 * @property {string} addedDate - 追加日
 * @property {string} lastConfirmedDate - 最終確認日
 * @property {string} source - 追加元 (auto/manual)
 * @property {number} row - シート上の行番号（1始まり）
 */

/**
 * @typedef {Object} BlacklistResult
 * @property {boolean} found - ブラックリストに存在するか
 * @property {BlacklistEntry|null} entry - エントリ情報
 * @property {boolean} isInGracePeriod - 猶予期間内か
 */

/**
 * メールアドレスがブラックリストに登録されているか確認する
 * @param {string} email - チェック対象のメールアドレス
 * @returns {BlacklistResult}
 */
function isBlacklisted(email) {
  try {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      return { found: false, entry: null, isInGracePeriod: false };
    }

    const sheet = getBlacklistSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      return { found: false, entry: null, isInGracePeriod: false };
    }

    const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    for (let i = 0; i < data.length; i++) {
      const rowEmail = normalizeEmail(String(data[i][0]));
      if (rowEmail === normalized) {
        const addedDate = new Date(data[i][1]);
        const daysElapsed = daysBetween(addedDate, new Date());
        const isInGracePeriod = daysElapsed <= CONFIG.BLACKLIST_GRACE_PERIOD_DAYS;

        return {
          found: true,
          entry: {
            email: rowEmail,
            addedDate: String(data[i][1]),
            lastConfirmedDate: String(data[i][2]),
            source: String(data[i][3]),
            row: i + 2, // ヘッダー行分 + 0始まりインデックス分
          },
          isInGracePeriod: isInGracePeriod,
        };
      }
    }

    return { found: false, entry: null, isInGracePeriod: false };
  } catch (e) {
    console.error('ブラックリスト検索エラー:', e);
    return { found: false, entry: null, isInGracePeriod: false };
  }
}

/**
 * ブラックリストにメールアドレスを追加する
 * 既に存在する場合は last_confirmed_date のみ更新する
 * @param {string} email - 追加対象のメールアドレス
 * @param {string} source - 追加元 ("auto" または "manual")
 */
function addToBlacklist(email, source) {
  try {
    const normalized = normalizeEmail(email);
    if (!normalized) return;

    const result = isBlacklisted(normalized);
    if (result.found) {
      updateLastConfirmed(normalized);
      return;
    }

    const sheet = getBlacklistSheet();
    const now = formatDate(new Date());
    sheet.appendRow([normalized, now, now, source]);
  } catch (e) {
    console.error('ブラックリスト追加エラー:', e);
  }
}

/**
 * ブラックリストからメールアドレスを削除する
 * @param {string} email - 削除対象のメールアドレス
 */
function removeFromBlacklist(email) {
  try {
    const normalized = normalizeEmail(email);
    if (!normalized) return;

    const result = isBlacklisted(normalized);
    if (!result.found) return;

    const sheet = getBlacklistSheet();
    sheet.deleteRow(result.entry.row);
  } catch (e) {
    console.error('ブラックリスト削除エラー:', e);
  }
}

/**
 * ブラックリストの last_confirmed_date を更新する
 * @param {string} email - 更新対象のメールアドレス
 */
function updateLastConfirmed(email) {
  try {
    const normalized = normalizeEmail(email);
    if (!normalized) return;

    const result = isBlacklisted(normalized);
    if (!result.found) return;

    const sheet = getBlacklistSheet();
    sheet.getRange(result.entry.row, 3).setValue(formatDate(new Date()));
  } catch (e) {
    console.error('ブラックリスト更新エラー:', e);
  }
}
