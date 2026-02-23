/**
 * Gmail REST API クライアント
 *
 * GmailApp の日次制限 (20,000回) を回避するため、
 * Gmail REST API を UrlFetchApp 経由で直接呼び出す。
 * 認証は ScriptApp.getOAuthToken() で取得した OAuth トークンを使用。
 *
 * 主な責務:
 * - 未処理メールの取得（_filtered/processed ラベルがないもの）
 * - メールの詳細情報（件名・本文・送信元）の取得
 * - ラベルの作成・付与・除去
 * - メールのアーカイブ（INBOX ラベル除去）
 */

/** @type {Object<string, string>} ラベル名 → ラベルID のキャッシュ */
const labelIdCache_ = {};

/**
 * Gmail REST API への共通リクエスト関数
 * @param {string} endpoint - CONFIG.GMAIL_API_BASE からの相対パス
 * @param {Object} [options={}] - UrlFetchApp.fetch に渡すオプション
 * @returns {Object} パース済みレスポンス
 * @throws {Error} API リクエスト失敗時
 */
function gmailApiRequest(endpoint, options = {}) {
  const url = CONFIG.GMAIL_API_BASE + endpoint;
  const token = ScriptApp.getOAuthToken();

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
      `Gmail API エラー: ${responseCode} ${response.getContentText()} (endpoint: ${endpoint})`
    );
  }

  const content = response.getContentText();
  return content ? JSON.parse(content) : {};
}

/**
 * 未処理メールのメッセージ情報一覧を取得する
 * @returns {{ id: string, threadId: string }[]} メッセージ情報の配列
 */
function getUnprocessedMessages() {
  const query = `to:${CONFIG.TARGET_EMAIL} in:inbox -label:${CONFIG.LABEL_PROCESSED}`;
  const endpoint = `/messages?q=${encodeURIComponent(query)}&maxResults=500`;

  try {
    const data = gmailApiRequest(endpoint);
    if (!data.messages || data.messages.length === 0) {
      return [];
    }
    // id と threadId の両方を返す
    return data.messages.map((msg) => ({ id: msg.id, threadId: msg.threadId }));
  } catch (e) {
    console.error('未処理メール取得に失敗:', e.message);
    return [];
  }
}

/**
 * メールの詳細情報を取得する
 * @param {string} messageId - Gmail メッセージID
 * @returns {{ id: string, threadId: string, from: string, subject: string, body: string, date: string }}
 */
function getMessageDetail(messageId) {
  const data = gmailApiRequest(`/messages/${messageId}?format=full`);
  const headers = data.payload.headers || [];

  const getHeader = (name) => {
    const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return header ? header.value : '';
  };

  const subject = getHeader('Subject');
  const from = getHeader('From');
  const date = getHeader('Date');

  const body = extractBody_(data.payload);

  return {
    id: messageId,
    threadId: data.threadId || '',
    from: from,
    subject: subject,
    body: truncateText(body, CONFIG.EMAIL_BODY_MAX_LENGTH),
    date: date,
  };
}

/**
 * スレッド内に自社ドメインからの返信があるか確認する
 * CONFIG.COMPANY_DOMAINS に含まれるドメインからのメッセージが1件以上あれば true を返す。
 * @param {string} threadId - Gmail スレッドID
 * @returns {boolean} 自社からの返信があれば true
 */
function hasCompanyReply(threadId) {
  try {
    const data = gmailApiRequest(
      `/threads/${threadId}?format=metadata&metadataHeaders=From`
    );
    const messages = data.messages || [];

    for (const message of messages) {
      const headers = (message.payload && message.payload.headers) || [];
      const fromHeader = headers.find(
        (h) => h.name.toLowerCase() === 'from'
      );
      if (!fromHeader) continue;

      const fromValue = fromHeader.value || '';
      // "Name <address@domain>" または "address@domain" 形式に対応
      const match = fromValue.match(/<([^>]+)>/) || fromValue.match(/(\S+@\S+)/);
      const emailAddress = match ? match[1].toLowerCase() : fromValue.toLowerCase();

      for (const domain of CONFIG.COMPANY_DOMAINS) {
        if (emailAddress.endsWith('@' + domain)) {
          return true;
        }
      }
    }

    return false;
  } catch (e) {
    console.error(`スレッド取得に失敗 (threadId: ${threadId}):`, e.message);
    // エラー時はスキップせず通常の判定フローへ進める
    return false;
  }
}

/**
 * メールの payload から本文を抽出する（multipart 対応）
 * text/plain を優先し、なければ text/html を stripHtml() で変換
 * @param {Object} payload - Gmail API のメッセージ payload
 * @returns {string} メール本文
 * @private
 */
function extractBody_(payload) {
  // 単一パートの場合
  if (payload.body && payload.body.data) {
    const mimeType = payload.mimeType || '';
    const decoded = base64UrlDecode(payload.body.data);
    if (mimeType === 'text/html') {
      return stripHtml(decoded);
    }
    return decoded;
  }

  // multipart の場合、parts を再帰的に探索
  if (payload.parts && payload.parts.length > 0) {
    let plainText = '';
    let htmlText = '';

    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        plainText = base64UrlDecode(part.body.data);
      } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
        htmlText = base64UrlDecode(part.body.data);
      } else if (part.parts) {
        // ネストされた multipart（例: multipart/alternative 内の multipart/related）
        const nested = extractBody_(part);
        if (nested) {
          // ネストから取得できた場合、plain 優先で格納
          if (!plainText && part.mimeType !== 'text/html') {
            plainText = nested;
          }
          if (!htmlText) {
            htmlText = nested;
          }
        }
      }
    }

    if (plainText) return plainText;
    if (htmlText) return stripHtml(htmlText);
  }

  return '';
}

/**
 * ラベルが存在することを確認し、なければ作成する
 * @param {string} labelName - ラベル名
 * @returns {string} ラベルID
 */
function ensureLabelExists(labelName) {
  // キャッシュを確認
  const cachedId = getLabelId(labelName);
  if (cachedId) {
    return cachedId;
  }

  // ラベルを新規作成
  try {
    const data = gmailApiRequest('/labels', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        name: labelName,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    });

    labelIdCache_[labelName] = data.id;
    return data.id;
  } catch (e) {
    console.error(`ラベル "${labelName}" の作成に失敗:`, e.message);
    throw e;
  }
}

/**
 * ラベル名からラベルIDを取得する（キャッシュ付き）
 * @param {string} labelName - ラベル名
 * @returns {string|null} ラベルID。見つからない場合は null
 */
function getLabelId(labelName) {
  // キャッシュにあればそれを返す
  if (labelIdCache_[labelName]) {
    return labelIdCache_[labelName];
  }

  try {
    const data = gmailApiRequest('/labels');
    const labels = data.labels || [];

    // 取得した全ラベルをキャッシュに格納
    for (const label of labels) {
      labelIdCache_[label.name] = label.id;
    }

    return labelIdCache_[labelName] || null;
  } catch (e) {
    console.error('ラベル一覧の取得に失敗:', e.message);
    return null;
  }
}

/**
 * メッセージにラベルを付与する
 * @param {string} messageId - Gmail メッセージID
 * @param {string} labelName - 付与するラベル名
 */
function addLabel(messageId, labelName) {
  const labelId = ensureLabelExists(labelName);

  try {
    gmailApiRequest(`/messages/${messageId}/modify`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        addLabelIds: [labelId],
      }),
    });
  } catch (e) {
    console.error(`ラベル "${labelName}" の付与に失敗 (messageId: ${messageId}):`, e.message);
    throw e;
  }
}

/**
 * メッセージからラベルを除去する
 * @param {string} messageId - Gmail メッセージID
 * @param {string} labelName - 除去するラベル名
 */
function removeLabel(messageId, labelName) {
  const labelId = getLabelId(labelName);
  if (!labelId) {
    console.warn(`ラベル "${labelName}" が見つかりません`);
    return;
  }

  try {
    gmailApiRequest(`/messages/${messageId}/modify`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        removeLabelIds: [labelId],
      }),
    });
  } catch (e) {
    console.error(`ラベル "${labelName}" の除去に失敗 (messageId: ${messageId}):`, e.message);
    throw e;
  }
}

/**
 * メッセージをゴミ箱に移動する
 * @param {string} messageId
 */
function trashMessage(messageId) {
  gmailApiRequest('/messages/' + messageId + '/trash', {
    method: 'post',
  });
}

/**
 * メッセージをアーカイブする（INBOX ラベルを除去）
 * @param {string} messageId - Gmail メッセージID
 */
function archiveMessage(messageId) {
  try {
    gmailApiRequest(`/messages/${messageId}/modify`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        removeLabelIds: ['INBOX'],
      }),
    });
  } catch (e) {
    console.error(`アーカイブに失敗 (messageId: ${messageId}):`, e.message);
    throw e;
  }
}
