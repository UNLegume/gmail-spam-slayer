/**
 * Gemini API を使用したメール分類器
 *
 * メールの送信元・件名・本文を Gemini 2.5 Flash で分析し、
 * legitimate / spam の二値分類を行う。
 *
 * 主な責務:
 * - Gemini API へのリクエスト送信
 * - プロンプト構築（送信元・件名・本文をコンテキストとして渡す）
 * - レスポンスのパース（is_legitimate を classification/confidence/reason に変換）
 * - エラーハンドリング（API 障害時は legitimate を返す）
 *
 * 期待するレスポンス形式（Gemini から）:
 * {
 *   "is_legitimate": true | false,
 *   "confidence": 0.0 - 1.0,
 *   "reason": "判定理由（30字以内）"
 * }
 *
 * 戻り値の形式（main.gs との互換性維持）:
 * {
 *   "classification": "spam" | "legitimate",
 *   "confidence": 0.0 - 1.0,
 *   "reason": "判定理由"
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
 * @param {string} from - 送信元アドレス
 * @returns {string} 結合されたプロンプト
 */
function buildClassificationPrompt(subject, body, from) {
  const truncatedBody = body && body.length > CONFIG.EMAIL_BODY_MAX_LENGTH
    ? body.substring(0, CONFIG.EMAIL_BODY_MAX_LENGTH) + '...(以下省略)'
    : body || '';

  return `あなたは日本語のビジネスメールを判定するエキスパートです。

## 受信者の背景
受信者はSES（システムエンジニアリングサービス）・人材紹介事業を運営する会社です。
このメールアドレスはSES案件のやり取り用メーリングリストです。

## 判定方針
以下の「legitimateの条件」に**いずれか1つでも**明確に該当する場合のみ is_legitimate: true とする。
それ以外はすべて is_legitimate: false（spam）とする。

## legitimateの条件（6項目）
1. SES案件に関する要員募集・案件紹介・要員提案（具体性の程度は問わない。案件一覧やスキルシート送付も含む）
2. 既存取引先からの業務連絡（請求・契約・納品等）
3. 利用中サービスからの重要通知（障害・セキュリティ・契約変更等）
4. 具体的なプロジェクト名や担当者名を挙げた要員提案・スカウト
5. 社内・取引先との進行中案件に関する連絡
6. 自社サービスや問い合わせフォームからの自動返信・受付確認メール

## spamの定義
上記6項目のいずれにも該当しないメールはすべて spam。
一方的な営業・宣伝・セミナー案内・ツール紹介・DX提案・採用媒体営業・BPO営業等はすべて spam。

## 回答形式
必ず以下のJSON形式で回答してください:
{
  "is_legitimate": true または false,
  "confidence": 0.0から1.0の数値（判定の確信度）,
  "reason": "日本語で30字以内の判定理由"
}

## 分類対象のメール

送信元: ${from || '(不明)'}
件名: ${subject || '(件名なし)'}

本文:
${truncatedBody || '(本文なし)'}`;
}

/**
 * Gemini API を使用してメールを分類する
 * @param {string} subject - メールの件名
 * @param {string} body - メールの本文
 * @param {string} from - 送信元アドレス
 * @returns {{ classification: string, confidence: number, reason: string }}
 */
function classifyEmail(subject, body, from) {
  try {
    const prompt = buildClassificationPrompt(subject, body, from);
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
            is_legitimate: { type: 'BOOLEAN' },
            confidence: { type: 'NUMBER' },
            reason: { type: 'STRING' },
          },
          required: ['is_legitimate', 'confidence', 'reason'],
        },
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
          classification: 'legitimate',
          confidence: 0.0,
          reason: `API error: HTTP ${statusCode} リトライ超過`,
        };
      }

      console.warn(`Gemini API ${statusCode}: ${CONFIG.API_RETRY_COOLDOWN_MS / 1000}秒待機してリトライ (${attempt + 1}/${CONFIG.API_RETRY_MAX})`);
      Utilities.sleep(CONFIG.API_RETRY_COOLDOWN_MS);
    }

    if (statusCode !== 200) {
      const errorBody = response.getContentText();
      console.error(`Gemini API エラー (HTTP ${statusCode}): ${errorBody}`);
      return {
        classification: 'legitimate',
        confidence: 0.0,
        reason: `API error: HTTP ${statusCode}`,
      };
    }

    const responseData = JSON.parse(response.getContentText());
    const parts = responseData.candidates[0].content.parts;
    const content = parts[parts.length - 1].text;
    const result = JSON.parse(content);

    // is_legitimate の型を検証
    if (typeof result.is_legitimate !== 'boolean') {
      console.warn(`不正な is_legitimate 値: ${result.is_legitimate}`);
      return {
        classification: 'legitimate',
        confidence: 0.0,
        reason: `不正な分類結果: ${result.is_legitimate}`,
      };
    }

    const confidence = Number(result.confidence);
    if (isNaN(confidence) || confidence < 0 || confidence > 1) {
      console.warn(`不正な confidence 値: ${result.confidence}`);
      return {
        classification: 'legitimate',
        confidence: 0.0,
        reason: `不正な確信度: ${result.confidence}`,
      };
    }

    // is_legitimate を classification に変換（main.gs との互換性維持）
    const classification = result.is_legitimate ? 'legitimate' : 'spam';

    return {
      classification: classification,
      confidence: confidence,
      reason: result.reason || '理由なし',
    };
  } catch (e) {
    console.error(`classifyEmail エラー: ${e.message}`);
    return {
      classification: 'legitimate',
      confidence: 0.0,
      reason: `API error: ${e.message}`,
    };
  }
}
