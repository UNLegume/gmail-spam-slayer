/**
 * 処理ログ記録
 *
 * Google Spreadsheet の「ProcessLog」シートに全処理結果を記録する。
 *
 * シート構造:
 * | A: timestamp | B: message_id | C: from | D: subject | E: classification | F: confidence | G: action | H: reason |
 *
 * 主な責務:
 * - ログ行の追記
 * - ヘッダー行の自動作成（シートが空の場合）
 * - バッチ書き込み（複数ログを一括で記録）
 */

/** @type {string[]} ログシートのヘッダー行 */
const LOG_HEADERS = ['timestamp', 'message_id', 'from', 'subject', 'classification', 'confidence', 'action', 'reason'];

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
  }
  return sheet;
}

/**
 * @typedef {Object} ProcessingResult
 * @property {string} messageId - Gmail メッセージ ID
 * @property {string} from - 送信元メールアドレス
 * @property {string} subject - メール件名
 * @property {string} classification - 判定結果 (spam/legitimate/uncertain)
 * @property {number} confidence - 確信度 (0-1)
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
      result.confidence,
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
      result.confidence,
      result.action,
      result.reason,
    ]);

    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, rows.length, LOG_HEADERS.length).setValues(rows);
  } catch (e) {
    console.error('バッチログ記録エラー:', e);
  }
}
