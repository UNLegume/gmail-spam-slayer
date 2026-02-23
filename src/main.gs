/**
 * メインエントリポイント・処理フロー制御
 *
 * 午前10時と午後7時の1日2回の GAS トリガーから呼び出され、以下のフローを実行:
 * 1. Gmail REST API で未処理メールを取得（GAS実行時間制限に基づく時間ベース制御、5分経過で安全終了）
 * 2. 各メールについて:
 *    a. スレッド内に自社ドメイン（finn.co.jp / ex.finn.co.jp）からの返信があるか確認
 *       → あればスパム判定をスキップし、_filtered/processed ラベルのみ付与
 *    b. 送信元がブラックリストにあるか確認
 *    c. ブラックリスト登録済み → 即ゴミ箱に移動（AI判定なし）
 *    d. ブラックリスト未登録 → Gemini API で判定
 *    e. 判定結果に基づくアクション実行
 *    f. 処理ログ記録
 * 3. 処理済みラベルを付与
 *
 * 主な責務:
 * - トリガーのセットアップ / 削除
 * - 処理フローの制御（各モジュールの呼び出し）
 * - エラーハンドリング（1通の失敗が全体を止めないように）
 */

/**
 * メイン処理関数。GAS トリガーから呼び出される。
 * 未処理メールを取得し、自社返信確認 → ブラックリスト確認 → AI判定 → アクション実行の
 * フローを各メールに対して実行する。
 * GAS の実行時間制限（6分）に対して5分経過で安全に処理を終了する時間ベース制御を行う。
 */
function processEmails() {
  const startTime = Date.now();

  // 必要なラベルの存在を事前に確認
  ensureLabelExists(CONFIG.LABEL_BLOCKED);
  ensureLabelExists(CONFIG.LABEL_PROCESSED);

  // 未処理メールを取得（id と threadId を含むオブジェクトの配列）
  const messages = getUnprocessedMessages();
  if (!messages || messages.length === 0) {
    console.log('未処理メールはありません');
    return;
  }

  console.log(`${messages.length} 件の未処理メールを処理開始`);

  // 処理結果のカウンター
  const summary = {
    total: messages.length,
    skipped_company_reply: 0,
    blocked_by_blacklist: 0,
    blocked_by_ai: 0,
    kept_in_inbox: 0,
    errors: 0,
  };

  for (const message of messages) {
    // 実行時間チェック（5分経過で安全に終了）
    if (Date.now() - startTime > CONFIG.MAX_EXECUTION_MS) {
      console.log('実行時間制限に近づいたため処理を終了します');
      break;
    }
    const messageId = message.id;
    try {
      // メール詳細を取得
      const detail = getMessageDetail(messageId);
      const senderEmail = normalizeEmail(detail.from);

      // スレッドIDを取得（getMessageDetail の戻り値を優先し、なければ getUnprocessedMessages の値を使用）
      const threadId = detail.threadId || message.threadId;

      let classification;
      let confidence;
      let action;
      let reason;

      // 自社からの返信があるスレッドはスパム判定をスキップ
      if (threadId && hasCompanyReply(threadId)) {
        classification = 'legitimate';
        action = 'skipped_company_reply';
        reason = '自社ドメインからの返信あり';
      } else {
        // ブラックリスト確認
        const blacklistStatus = isBlacklisted(senderEmail);

        if (blacklistStatus.found) {
          // ブラックリスト登録済み → 即ゴミ箱に移動（AI判定なし）
          trashMessage(messageId);

          classification = 'spam';
          confidence = 1.0;
          action = 'blocked_by_blacklist';
          reason = 'ブラックリスト登録済み';
        } else {
          // ブラックリスト未登録 → AI 判定
          // Gemini 無料枠のレートリミット対策（10 req/min）
          Utilities.sleep(CONFIG.API_CALL_DELAY_MS);
          const result = classifyEmail(detail.subject, detail.body);
          classification = result.classification;
          confidence = result.confidence;
          reason = result.reason;

          if (classification === 'spam' && confidence >= CONFIG.SPAM_CONFIDENCE_THRESHOLD) {
            // 高確信度スパム → アーカイブ + ブラックリスト追加
            archiveMessage(messageId);
            addLabel(messageId, CONFIG.LABEL_BLOCKED);
            addToBlacklist(senderEmail, 'auto');
            action = 'blocked_by_ai';
          } else {
            // legitimate / uncertain / 低確信度spam → 受信トレイに残す
            action = 'kept_in_inbox';
          }
        }
      }

      // 処理済みラベルを付与
      addLabel(messageId, CONFIG.LABEL_PROCESSED);

      // 処理ログを記録
      logProcessingResult({
        messageId,
        from: senderEmail,
        subject: detail.subject,
        classification,
        action,
        reason,
      });

      // サマリーカウンターを更新
      summary[action] = (summary[action] || 0) + 1;
    } catch (error) {
      console.error(`メール処理エラー (messageId: ${messageId}): ${error.message}`);
      summary.errors++;
    }
  }

  // 処理結果サマリーを出力
  console.log('--- 処理結果サマリー ---');
  console.log(`処理件数: ${summary.total}`);
  console.log(`自社返信済みスキップ: ${summary.skipped_company_reply}`);
  console.log(`ブラックリストによりブロック: ${summary.blocked_by_blacklist}`);
  console.log(`AI判定によりブロック: ${summary.blocked_by_ai}`);
  console.log(`受信トレイに残す: ${summary.kept_in_inbox}`);
  console.log(`エラー: ${summary.errors}`);
}

/**
 * 初期化関数。GAS エディタから手動実行する。
 * - 必要なラベルの作成（_filtered/blocked, _filtered/processed）
 * - スプレッドシートのシート作成（Blacklist, ProcessLog）
 * - Script Properties（GEMINI_API_KEY と SPREADSHEET_ID）の設定確認
 * - 「初期化完了」ログの出力
 *
 * processEmails() からは呼び出さない
 * （processEmails 内でラベル作成・シート取得は既に行われているため）。
 */
function initialize() {
  // 必要なラベルの作成（既に存在する場合はスキップ）
  console.log('ラベルの作成を確認中...');
  ensureLabelExists(CONFIG.LABEL_BLOCKED);
  console.log(`  ラベル "${CONFIG.LABEL_BLOCKED}" OK`);
  ensureLabelExists(CONFIG.LABEL_PROCESSED);
  console.log(`  ラベル "${CONFIG.LABEL_PROCESSED}" OK`);

  // スプレッドシートのシート作成（存在しない場合は自動作成される）
  console.log('スプレッドシートのシートを確認中...');
  getBlacklistSheet();
  console.log(`  シート "${CONFIG.BLACKLIST_SHEET_NAME}" OK`);
  getLogSheet();
  console.log(`  シート "${CONFIG.LOG_SHEET_NAME}" OK`);

  // Script Properties の確認
  console.log('Script Properties を確認中...');
  let hasError = false;

  const geminiApiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!geminiApiKey) {
    console.error('  [ERROR] GEMINI_API_KEY が設定されていません');
    hasError = true;
  } else {
    console.log('  GEMINI_API_KEY OK');
  }

  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) {
    console.error('  [ERROR] SPREADSHEET_ID が設定されていません');
    hasError = true;
  } else {
    console.log('  SPREADSHEET_ID OK');
  }

  if (hasError) {
    console.error('初期化に問題があります。GAS エディタの「プロジェクトの設定」>「スクリプト プロパティ」を確認してください。');
    return;
  }

  console.log('初期化完了');
}

/**
 * processEmails の午前10時と午後7時の1日2回トリガーをセットアップする。
 * 既存のトリガーがあれば削除してから新規作成する。
 */
function setupTrigger() {
  // 既存の processEmails トリガーをすべて削除（重複防止）
  removeTrigger();

  // 午前10時のトリガーを作成
  ScriptApp.newTrigger('processEmails')
    .timeBased()
    .atHour(10)
    .everyDays(1)
    .create();

  // 午後19時のトリガーを作成
  ScriptApp.newTrigger('processEmails')
    .timeBased()
    .atHour(19)
    .everyDays(1)
    .create();

  console.log('Triggers created: processEmails at 10:00 and 19:00 daily');
}

/**
 * processEmails のトリガーを全削除する。
 */
function removeTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'processEmails') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  console.log('processEmails トリガーを削除しました');
}
