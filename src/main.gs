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
 * ブラックリスト自動解除処理。
 * 直近 CONFIG.BLACKLIST_REVIEW_DAYS 日以内に追加されたエントリを対象に、
 * Gmail REST API でその送信元のメールを検索し、スレッド内に自社返信があれば
 * ブラックリストから自動解除する。
 */
function reviewBlacklist() {
  const entries = getRecentBlacklistEntries(CONFIG.BLACKLIST_REVIEW_DAYS);
  if (entries.length === 0) {
    return;
  }

  console.log(`ブラックリスト自動解除チェック: ${entries.length} 件対象`);

  for (const entry of entries) {
    try {
      const email = entry.email;
      const endpoint =
        `/messages?q=${encodeURIComponent('from:' + email + ' newer_than:' + CONFIG.BLACKLIST_REVIEW_DAYS + 'd')}&maxResults=5`;
      const data = gmailApiRequest(endpoint);

      if (!data.messages || data.messages.length === 0) {
        continue;
      }

      // ヒットしたメッセージの threadId を重複なく収集
      const threadIds = [];
      for (const msg of data.messages) {
        if (msg.threadId && threadIds.indexOf(msg.threadId) === -1) {
          threadIds.push(msg.threadId);
        }
      }

      // いずれかのスレッドに自社返信があれば解除
      for (const threadId of threadIds) {
        if (hasCompanyReply(threadId)) {
          removeFromBlacklist(email);
          console.log(`ブラックリスト自動解除: ${email} (threadId: ${threadId} に自社返信あり)`);
          break;
        }
      }
    } catch (e) {
      console.error(`ブラックリスト自動解除エラー (email: ${entry.email}): ${e.message}`);
    }
  }
}

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

  // ブラックリスト自動解除（自社返信があるスレッドの送信元を解除）
  reviewBlacklist();

  // 未処理メールを取得（id と threadId を含むオブジェクトの配列）
  const messages = getUnprocessedMessages();
  if (!messages || messages.length === 0) {
    console.log('未処理メールはありません');
    notifyNewBlacklistEntries();
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
          // ブラックリスト登録済み → アーカイブ（AI判定なし）
          archiveMessage(messageId);
          addLabel(messageId, CONFIG.LABEL_BLOCKED);

          classification = 'spam';
          confidence = 1.0;
          action = 'blocked_by_blacklist';
          reason = 'ブラックリスト登録済み';
        } else {
          // ブラックリスト未登録 → AI 判定
          // Gemini 無料枠のレートリミット対策（10 req/min）
          Utilities.sleep(CONFIG.API_CALL_DELAY_MS);
          const result = classifyEmail(detail.subject, detail.body, detail.from);
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

  notifyNewBlacklistEntries();
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

  if (CONFIG.SLACK_NOTIFY_ENABLED) {
    const slackBotToken = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
    const slackChannelId = PropertiesService.getScriptProperties().getProperty('SLACK_CHANNEL_ID');
    if (!slackBotToken || !slackChannelId) {
      console.warn('  [WARN] SLACK_BOT_TOKEN または SLACK_CHANNEL_ID が設定されていません（Slack通知は無効になります）');
    } else {
      console.log('  SLACK_BOT_TOKEN OK');
      console.log('  SLACK_CHANNEL_ID OK');
    }
  }

  if (hasError) {
    console.error('初期化に問題があります。GAS エディタの「プロジェクトの設定」>「スクリプト プロパティ」を確認してください。');
    return;
  }

  console.log('初期化完了');
}

/**
 * トリガーのセットアップは GAS エディタの UI から行う。
 * 「トリガー」画面で以下を手動設定:
 *   - 関数: processEmails / 時間ベース / 毎日 / 午前10時
 *   - 関数: processEmails / 時間ベース / 毎日 / 午後7時
 */
