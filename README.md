# Gmail Spam Slayer

`service@finn.co.jp` に届く一方的な営業メールを、Google Apps Script + Gmail REST API + Gemini API で自動判定・フィルタリングするシステム。

---

## 技術スタック

- **実行基盤**: Google Apps Script（1日2回トリガー、V8 ランタイム）
- **メール操作**: Gmail REST API（`UrlFetchApp.fetch()` + OAuth トークン）
- **AI 判定**: Gemini API `gemini-2.5-flash`（temperature: 0）
- **データ保存**: Google Spreadsheet（ブラックリスト + 処理ログ）

---

## 処理フロー

```
トリガー起動（1日2回：午前10時・午後7時）
  |
  +-- Gmail REST API で未処理メールを取得（最大50通）
        |
        +-- [送信元がブラックリスト登録済み]
        |     --> ゴミ箱に移動（AI判定なし）
        |         + _filtered/processed ラベル付与
        |         + 処理ログ記録
        |
        +-- [送信元がブラックリスト未登録]
              --> Gemini API で AI 判定
                  |
                  +-- spam (confidence >= 0.8)
                  |     --> アーカイブ + _filtered/blocked ラベル + ブラックリスト自動追加
                  |         + _filtered/processed ラベル付与 + 処理ログ記録
                  +-- spam (confidence < 0.8)
                  |     --> _filtered/low_confidence ラベルのみ付与
                  |         + _filtered/processed ラベル付与 + 処理ログ記録
                  +-- legitimate / uncertain
                        --> 受信トレイに残す
                            + _filtered/processed ラベル付与 + 処理ログ記録
```

---

## 判定ルール

| 判定 | confidence | アクション |
|------|------------|-----------|
| ブラックリスト登録済み | — | ゴミ箱に移動（AI判定なし） |
| spam | >= 0.8 | アーカイブ + `_filtered/blocked` ラベル + ブラックリスト自動追加 |
| spam | < 0.8 | `_filtered/low_confidence` ラベルのみ（受信トレイに残す） |
| legitimate | — | 受信トレイに残す |
| uncertain | — | 受信トレイに残す（安全側に倒す） |

---

## 分類基準の詳細

受信者の背景として、SES（システムエンジニアリングサービス）・人材紹介事業を運営する会社であることをプロンプトに含めて判定する。

### spam（営業メール・迷惑メール）

一方的な売り込みメールを spam と判定する。具体的には以下が該当する。

- IT製品・SaaSツール・マーケティングサービス等の宣伝
- セミナー・ウェビナー・イベント・展示会の案内
- 資料送付の打診・ホワイトペーパーの案内
- 面談・商談・アポイントメントの一方的な依頼
- コンサルティング・広告・Web制作・DX推進等のサービス紹介
- 採用媒体・HR Tech・福利厚生サービス等の営業
- オフィス用品・回線・電力・不動産等の営業
- 一括送信されたと思われるテンプレート的なメール
- 受信者のSES・人材事業と無関係な商品やサービスの売り込み全般

### legitimate（正規のメール）

SES・人材ビジネスに直接関係する具体的なやり取りを legitimate と判定する。

- SES案件の紹介（案件名・スキル要件・単価・期間・勤務地など具体的な案件情報を含む）
- エンジニアの要員提案・スキルシートの共有
- 協業・パートナー提携に関する具体的な打診
- 案件や要員に関する返信・やり取りの続き
- 人材紹介に関する具体的なマッチング提案
- 取引先・既存の関係者からの業務連絡
- 問い合わせへの回答・返信
- 利用中のサービスに関する通知（請求・アカウント・障害情報等）
- 社内連絡・チーム内のやり取り

### uncertain（判定不能）

以下の場合は uncertain として受信トレイに残す（安全側に倒す）。

- spam / legitimate のいずれにも明確に該当しない場合
- SES関連に見えるが具体性に欠け判断が難しい場合
- 情報が不足しており判断できない場合

---

## ブラックリスト仕様

スプレッドシートの `Blacklist` シートで管理する。

| カラム | 内容 |
|--------|------|
| email | メールアドレス（正規化済み・小文字） |
| added_date | ブラックリスト追加日時 |
| source | 追加元（`auto`: AI判定による自動追加 / `manual`: 手動追加） |

**ブラックリスト登録済みメールの動作**

- 登録済みアドレスからのメールは AI 判定を一切行わず即座にゴミ箱に移動する
- ゴミ箱に移動したメールは Gmail の仕様により30日後に自動的に完全削除される（30日以内であれば手動で復元可能）
- 登録アドレスが増えるほど AI API 呼び出しをスキップするため、実行時間が短縮される
- 誤登録した場合はスプレッドシートの `Blacklist` シートから該当行を手動で削除することで解除できる

シートは初回アクセス時に自動作成される。ヘッダー行は青色・太字・中央揃えで書式設定され、1行目が固定される。カラム幅と折り返し設定も自動で適用される。

---

## ディレクトリ構成

```
gmail-spam-slayer/
├── src/
│   ├── main.gs         # エントリポイント・処理フロー制御・トリガー管理
│   ├── config.gs       # 定数・設定値（機密情報はScript Propertiesから取得）
│   ├── gmailClient.gs  # Gmail REST API ラッパー（取得・ラベル・アーカイブ・ゴミ箱移動）
│   ├── classifier.gs   # Gemini API によるメール判定（プロンプト構築・レスポンス解析）
│   ├── blacklist.gs    # ブラックリスト管理（スプレッドシート CRUD）
│   ├── logger.gs       # 処理ログ記録（スプレッドシート ProcessLog シート）
│   ├── utils.gs        # ユーティリティ関数（メール正規化・日付計算等）
│   └── test.gs         # 動作確認用テスト関数
├── appsscript.json     # GAS マニフェスト（OAuth スコープ設定）
└── .clasp.json         # clasp 設定（スクリプトID）
```

---

## セットアップ手順

### 1. clasp でデプロイ

```bash
# clasp のインストール（初回のみ）
npm install -g @google/clasp

# GAS プロジェクトにプッシュ
clasp push
```

### 2. Script Properties の設定

GAS エディタの「プロジェクトの設定」>「スクリプト プロパティ」に以下を登録する。

| キー | 値 |
|------|----|
| `GEMINI_API_KEY` | Google AI Studio で発行した API キー |
| `SPREADSHEET_ID` | ブラックリスト・ログ用スプレッドシートの ID |

### 3. 動作確認

GAS エディタで以下のテスト関数を順番に実行する。

```
test1_Config()       # Script Properties が正しく設定されているか確認
test2_Classifier()   # Gemini API の疎通・分類動作を確認
test3_Gmail()        # Gmail REST API の疎通・メール取得を確認
test4_Spreadsheet()  # スプレッドシートの読み書きを確認
```

### 4. トリガーの設定

GAS エディタで `setupTrigger()` を実行すると、`processEmails` の1日2回（午前10時・午後7時）トリガーが登録される。

```
setupTrigger()   # トリガーを登録（午前10時・午後7時）
removeTrigger()  # トリガーを削除（停止したい場合）
```

---

## 設定値一覧

`src/config.gs` の主要設定。

| 設定名 | 値 | 説明 |
|--------|----|------|
| `GEMINI_MODEL` | `gemini-2.5-flash` | 使用する Gemini モデル |
| `GEMINI_TEMPERATURE` | `0` | 応答の確定性（0 = 最大確定） |
| `GEMINI_MAX_TOKENS` | `1024` | 最大出力トークン数 |
| `MAX_EMAILS_PER_RUN` | `50` | 1回の実行で処理する最大メール数 |
| `EMAIL_BODY_MAX_LENGTH` | `2000` | 判定に使う本文の最大文字数 |
| `TARGET_EMAIL` | `service@finn.co.jp` | フィルタリング対象のメールアドレス |
| `SPAM_CONFIDENCE_THRESHOLD` | `0.8` | アーカイブ判定の確信度閾値 |
| `API_CALL_DELAY_MS` | `500` | API 呼び出し間のスリープ（ms） |
| `API_RETRY_MAX` | `3` | API リトライ上限回数 |
| `API_RETRY_COOLDOWN_MS` | `5000` | リトライ待機時間（ms） |

---

## Gmail REST API を使う理由

GAS 内蔵の `GmailApp` には1日20,000回の読み取り制限がある。Gmail REST API を `UrlFetchApp` 経由で直接呼び出すことでこの日次制限を回避できる。レートリミットは秒単位（250 quota units/sec/user）のみとなる。認証は `ScriptApp.getOAuthToken()` で取得した OAuth トークンを使用する。
