/**
 * ユーティリティ関数
 */

/**
 * メールアドレスを正規化する（小文字化・トリム）
 * @param {string} email
 * @returns {string}
 */
function normalizeEmail(email) {
  if (!email) return '';
  // "Name <email@example.com>" 形式から email 部分を抽出
  const match = email.match(/<([^>]+)>/);
  const addr = match ? match[1] : email;
  return addr.trim().toLowerCase();
}

/**
 * 日付を YYYY-MM-DD 形式の文字列に変換
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
}

/**
 * 2つの日付の差分を日数で返す
 * @param {Date} date1
 * @param {Date} date2
 * @returns {number}
 */
function daysBetween(date1, date2) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor(Math.abs(date2.getTime() - date1.getTime()) / msPerDay);
}

/**
 * HTML タグを除去してプレーンテキストにする
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 文字列を指定文字数で切り詰める
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * Base64url デコード（Gmail API のメッセージ本文用）
 * @param {string} encoded
 * @returns {string}
 */
function base64UrlDecode(encoded) {
  // base64url → 標準 base64 に変換
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  // パディング追加
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const decoded = Utilities.base64Decode(base64);
  return Utilities.newBlob(decoded).getDataAsString('UTF-8');
}
