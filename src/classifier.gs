/**
 * Gemini API を使用したメール分類器
 *
 * メールの件名と本文（先頭2,000文字）を Gemini 2.5 Flash で分析し、
 * spam / legitimate / uncertain に分類する。
 *
 * 主な責務:
 * - Gemini API へのリクエスト送信
 * - プロンプト構築（件名 + 本文をコンテキストとして渡す）
 * - レスポンスのパース（classification, confidence, reason を抽出）
 * - エラーハンドリング（API 障害時は uncertain を返す）
 *
 * 期待するレスポンス形式:
 * {
 *   "classification": "spam" | "legitimate" | "uncertain",
 *   "confidence": 0.0 - 1.0,
 *   "reason": "判定理由の説明"
 * }
 */

/**
 * Gemini API の 429 レスポンスから推奨リトライ待機時間(ms)を取得する
 * @param {string} responseBody - レスポンスボディ
 * @returns {number|null} 待機時間(ms)、取得できない場合は null
 */
function parseRetryDelay(responseBody) {
  try {
    const data = JSON.parse(responseBody);
    const retryInfo = (data.error && data.error.details || [])
      .find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
    if (retryInfo && retryInfo.retryDelay) {
      const seconds = parseFloat(retryInfo.retryDelay);
      if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
    }
  } catch (e) {
    // パース失敗は無視
  }
  return null;
}

/**
 * メール分類用のプロンプトを構築する
 * @param {string} subject - メールの件名
 * @param {string} body - メールの本文
 * @returns {string} 結合されたプロンプト
 */
function buildClassificationPrompt(subject, body) {
  const truncatedBody = body && body.length > CONFIG.EMAIL_BODY_MAX_LENGTH
    ? body.substring(0, CONFIG.EMAIL_BODY_MAX_LENGTH) + '...(以下省略)'
    : body || '';

  return `あなたは日本語の営業メール（迷惑メール）を判定するエキスパートです。
与えられたメールの件名と本文を分析し、以下の分類を行ってください。

## 分類カテゴリ

### spam（営業メール・迷惑メール）
以下の特徴を持つメールです:
- 一方的な売り込み・商品やサービスの宣伝
- セミナー・ウェビナー・イベントの案内
- 資料送付の打診・ホワイトペーパーの案内
- 面談・商談・アポイントメントの依頼
- サービス紹介・導入提案
- 求人・人材紹介・採用支援の営業
- 一括送信されたと思われるメール

### legitimate（正規のメール）
以下の特徴を持つメールです:
- 取引先・既存の関係者からの業務連絡
- 問い合わせへの回答・返信
- 利用中のサービスに関する通知（請求・アカウント・障害情報等）
- 社内連絡・チーム内のやり取り
- 配送通知・注文確認など取引に基づく通知

### uncertain（判定不能）
- 上記のいずれにも明確に該当しない場合
- 情報が不足しており判断できない場合

## 回答形式
必ず以下のJSON形式で回答してください:
{
  "classification": "spam" または "legitimate" または "uncertain",
  "confidence": 0.0から1.0の数値（判定の確信度）,
  "reason": "日本語で判定理由を簡潔に説明"
}

## 分類対象のメール

件名: ${subject || '(件名なし)'}

本文:
${truncatedBody || '(本文なし)'}`;
}

/**
 * Gemini API を使用してメールを分類する
 * @param {string} subject - メールの件名
 * @param {string} body - メールの本文
 * @returns {{ classification: string, confidence: number, reason: string }}
 */
function classifyEmail(subject, body) {
  try {
    const prompt = buildClassificationPrompt(subject, body);
    const apiKey = getGeminiApiKey();

    const url = `${CONFIG.GEMINI_API_BASE}/${CONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const payload = {
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: CONFIG.GEMINI_TEMPERATURE,
        maxOutputTokens: CONFIG.GEMINI_MAX_TOKENS,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            classification: { type: 'STRING', enum: ['spam', 'legitimate', 'uncertain'] },
            confidence: { type: 'NUMBER' },
            reason: { type: 'STRING' },
          },
          required: ['classification', 'confidence', 'reason'],
        },
        // thinking モデルで responseMimeType が無視される問題を回避
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };

    let response;
    let statusCode;

    const retryableStatuses = [429, 500, 502, 503, 504];

    for (let attempt = 0; attempt <= CONFIG.API_RETRY_MAX; attempt++) {
      response = UrlFetchApp.fetch(url, options);
      statusCode = response.getResponseCode();

      if (!retryableStatuses.includes(statusCode)) break;

      if (attempt === CONFIG.API_RETRY_MAX) {
        console.error(`Gemini API エラー (HTTP ${statusCode}): ${CONFIG.API_RETRY_MAX}回リトライ後も失敗`);
        return {
          classification: 'uncertain',
          confidence: 0,
          reason: `Gemini API エラー (HTTP ${statusCode}) リトライ超過`,
        };
      }

      console.warn(`Gemini API ${statusCode}: ${CONFIG.API_RETRY_COOLDOWN_MS / 1000}秒待機してリトライ (${attempt + 1}/${CONFIG.API_RETRY_MAX})`);
      Utilities.sleep(CONFIG.API_RETRY_COOLDOWN_MS);
    }

    if (statusCode !== 200) {
      const errorBody = response.getContentText();
      console.error(`Gemini API エラー (HTTP ${statusCode}): ${errorBody}`);
      return {
        classification: 'uncertain',
        confidence: 0,
        reason: `Gemini API エラー (HTTP ${statusCode})`,
      };
    }

    const responseData = JSON.parse(response.getContentText());
    const content = responseData.candidates[0].content.parts[0].text;
    const result = JSON.parse(content);

    // レスポンスの妥当性を検証
    const validClassifications = ['spam', 'legitimate', 'uncertain'];
    if (!validClassifications.includes(result.classification)) {
      console.warn(`不正な classification 値: ${result.classification}`);
      return {
        classification: 'uncertain',
        confidence: 0,
        reason: `不正な分類結果: ${result.classification}`,
      };
    }

    const confidence = Number(result.confidence);
    if (isNaN(confidence) || confidence < 0 || confidence > 1) {
      console.warn(`不正な confidence 値: ${result.confidence}`);
      return {
        classification: 'uncertain',
        confidence: 0,
        reason: `不正な確信度: ${result.confidence}`,
      };
    }

    return {
      classification: result.classification,
      confidence: confidence,
      reason: result.reason || '理由なし',
    };
  } catch (e) {
    console.error(`classifyEmail エラー: ${e.message}`);
    return {
      classification: 'uncertain',
      confidence: 0,
      reason: `分類処理エラー: ${e.message}`,
    };
  }
}
