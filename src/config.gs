/**
 * アプリケーション設定
 * スプレッドシートIDやAPIキーはScript Propertiesから取得する
 */

const CONFIG = {
  // Gemini API
  GEMINI_API_BASE: 'https://generativelanguage.googleapis.com/v1beta/models',
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_TEMPERATURE: 0,
  GEMINI_MAX_TOKENS: 2048,

  // レートリミット対策（有料プラン: 1,000 req/min）
  API_CALL_DELAY_MS: 500,
  API_RETRY_MAX: 3,
  API_RETRY_COOLDOWN_MS: 5000,

  // メール処理
  MAX_EXECUTION_MS: 5 * 60 * 1000, // 5分 = 300,000ms（GAS 6分制限に対して1分のバッファ）
  EMAIL_BODY_MAX_LENGTH: 2000,
  TARGET_EMAIL: 'service@finn.co.jp',

  // 判定閾値
  SPAM_CONFIDENCE_THRESHOLD: 0.7,

  // ブラックリスト
  BLACKLIST_SHEET_NAME: 'Blacklist',

  // ログ
  LOG_SHEET_NAME: 'ProcessLog',

  // Gmail ラベル
  LABEL_BLOCKED: '_filtered/blocked',
  LABEL_PROCESSED: '_filtered/processed',

  // Gmail REST API
  GMAIL_API_BASE: 'https://www.googleapis.com/gmail/v1/users/me',

  // 自社ドメイン（これらからの返信があるスレッドはスパム判定をスキップ）
  COMPANY_DOMAINS: ['finn.co.jp', 'ex.finn.co.jp'],
};

/**
 * Script Properties から機密情報を取得するヘルパー
 * @param {string} key - プロパティキー
 * @returns {string} プロパティ値
 */
function getSecretProperty(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error(`Script Property "${key}" が設定されていません`);
  }
  return value;
}

/**
 * Gemini API キーを取得
 * @returns {string}
 */
function getGeminiApiKey() {
  return getSecretProperty('GEMINI_API_KEY');
}

/**
 * スプレッドシート ID を取得
 * @returns {string}
 */
function getSpreadsheetId() {
  return getSecretProperty('SPREADSHEET_ID');
}
