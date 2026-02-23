/**
 * メインエントリポイント・処理フロー制御
 *
 * 午前10時と午後7時の1日2回の GAS トリガーから呼び出され、以下のフローを実行:
 * 1. Gmail REST API で未処理メールを取得（最大50通）
 * 2. 各メールについて:
 *    a. 送信元がブラックリストにあるか確認
 *    b. ブラックリスト登録済み & 猶予期間外 → 即アーカイブ
 *    c. それ以外 → Gemini API で判定
 *    d. 判定結果に基づくアクション実行
 *    e. 処理ログ記録
 * 3. 処理済みラベルを付与
 *
 * 主な責務:
 * - トリガーのセットアップ / 削除
 * - 処理フローの制御（各モジュールの呼び出し）
 * - エラーハンドリング（1通の失敗が全体を止めないように）
 */

/**
 * メイン処理関数。GAS トリガーから呼び出される。
 * 未処理メールを取得し、ブラックリスト確認 → AI判定 → アクション実行の
 * フローを各メールに対して実行する。
 */
function processEmails() {
  // 必要なラベルの存在を事前に確認
  ensureLabelExists(CONFIG.LABEL_BLOCKED);
  ensureLabelExists(CONFIG.LABEL_LOW_CONFIDENCE);
  ensureLabelExists(CONFIG.LABEL_PROCESSED);

  // 未処理メールを取得
  const messageIds = getUnprocessedMessages();
  if (!messageIds || messageIds.length === 0) {
    console.log('未処理メールはありません');
    return;
  }

  console.log(`${messageIds.length} 件の未処理メールを処理開始`);

  // 処理結果のカウンター
  const summary = {
    total: messageIds.length,
    blocked_by_blacklist: 0,
    blocked_by_ai: 0,
    labeled_low_confidence: 0,
    unblocked_from_blacklist: 0,
    kept_in_inbox: 0,
    errors: 0,
  };

  for (const messageId of messageIds) {
    try {
      // メール詳細を取得
      const detail = getMessageDetail(messageId);
      const senderEmail = normalizeEmail(detail.from);

      // ブラックリスト確認
      const blacklistStatus = isBlacklisted(senderEmail);

      let classification;
      let confidence;
      let action;
      let reason;

      if (blacklistStatus.found && !blacklistStatus.isInGracePeriod) {
        // ブラックリスト登録済み & 猶予期間外 → ゴミ箱に移動
        trashMessage(messageId);
        updateLastConfirmed(senderEmail);

        classification = 'spam';
        confidence = 1.0;
        action = 'deleted_blacklisted';
        reason = 'ブラックリスト登録済み（猶予期間外）';
      } else {
        // ブラックリスト未登録 or 猶予期間内 → AI 判定
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
        } else if (classification === 'spam' && confidence < CONFIG.SPAM_CONFIDENCE_THRESHOLD) {
          // 低確信度スパム → ラベルのみ
          addLabel(messageId, CONFIG.LABEL_LOW_CONFIDENCE);
          action = 'labeled_low_confidence';
        } else if (classification === 'legitimate' && blacklistStatus.found && blacklistStatus.isInGracePeriod) {
          // 猶予期間内に legitimate 判定 → ブラックリストから解除
          removeFromBlacklist(senderEmail);
          action = 'unblocked_from_blacklist';
        } else {
          // legitimate / uncertain → 受信トレイに残す
          action = 'kept_in_inbox';
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
  console.log(`ブラックリストによりブロック: ${summary.blocked_by_blacklist}`);
  console.log(`AI判定によりブロック: ${summary.blocked_by_ai}`);
  console.log(`低確信度ラベル付与: ${summary.labeled_low_confidence}`);
  console.log(`ブラックリスト解除: ${summary.unblocked_from_blacklist}`);
  console.log(`受信トレイに残す: ${summary.kept_in_inbox}`);
  console.log(`エラー: ${summary.errors}`);
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
