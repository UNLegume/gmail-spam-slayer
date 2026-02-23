/**
 * 動作確認用テスト関数
 * 確認後に削除してください
 */

/** Step 1: Script Properties の確認 */
function test1_Config() {
  console.log('Gemini API Key:', getGeminiApiKey().substring(0, 8) + '...');
  console.log('Spreadsheet ID:', getSpreadsheetId());
  console.log('✅ Script Properties OK');
}

/** Step 2: Gemini API でメール分類テスト */
function test2_Classifier() {
  const result = classifyEmail(
    '【ご案内】貴社の売上を3倍にするAIツールのご紹介',
    'はじめまして。株式会社テストの田中です。突然のご連絡失礼いたします。弊社のAIツールを導入いただければ売上が3倍になります。ぜひ一度お打ち合わせの機会をいただけませんでしょうか。'
  );
  console.log('判定結果:', JSON.stringify(result, null, 2));
}

/** Step 3: Gmail API の疎通確認 */
function test3_Gmail() {
  const messages = getUnprocessedMessages();
  console.log('未処理メール数:', messages.length);
  if (messages.length > 0) {
    const detail = getMessageDetail(messages[0]);
    console.log('件名:', detail.subject);
    console.log('送信元:', detail.from);
    console.log('本文(先頭100文字):', detail.body.substring(0, 100));
  }
  console.log('✅ Gmail API OK');
}

/** Step 4: スプレッドシート（ブラックリスト・ログ）の確認 */
function test4_Spreadsheet() {
  // ブラックリスト
  addToBlacklist('test-spam@example.com', 'manual');
  const check = isBlacklisted('test-spam@example.com');
  console.log('ブラックリスト登録確認:', check.found);
  removeFromBlacklist('test-spam@example.com');
  console.log('ブラックリスト削除確認:', !isBlacklisted('test-spam@example.com').found);

  // ログ
  logProcessingResult({
    messageId: 'test-123',
    from: 'test@example.com',
    subject: 'テストメール',
    classification: 'spam',
    confidence: 0.95,
    action: 'blocked_by_ai',
    reason: 'テスト用ログ',
  });
  console.log('✅ スプレッドシートを確認してください（Blacklist / ProcessLog シート）');
}
