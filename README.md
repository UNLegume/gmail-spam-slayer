# Gmail Spam Slayer

`service@finn.co.jp` に届く一方的な営業メールを、Google Apps Script (GAS) + Gmail REST API + Gemini API で自動判定・フィルタリングするシステム。

## 技術スタック

- **実行基盤**: Google Apps Script（1日2回：午前10時・午後7時のトリガー、V8 ランタイム）
- **メール操作**: Gmail REST API（`UrlFetchApp.fetch()` + OAuth トークン）
- **AI 判定**: Gemini API `gemini-2.5-flash`（temperature: 0）
- **データ保存**: Google Spreadsheet（ブラックリスト + 処理ログ）

## 処理フロー

```
GAS トリガー起動（10:00 / 19:00）
  └── Gmail REST API で未処理メールを取得
        └── メールごとに以下を順番に実行
              |
              +-- [1] 自社返信チェック
              |       スレッドに @finn.co.jp / @ex.finn.co.jp からの返信あり
              |       --> スパム判定スキップ
              |           _filtered/processed ラベル付与
              |           受信トレイに残す
              |           処理ログ記録（classification: legitimate, action: skipped_company_reply）
              |
              +-- [2] ブラックリスト確認（自社返信なしの場合）
              |       登録済み
              |       --> 即ゴミ箱移動（AI判定なし）
              |           _filtered/processed ラベル付与
              |           処理ログ記録（action: blocked_by_blacklist）
              |
              +-- [3] Gemini API で AI 判定（ブラックリスト未登録の場合）
                      spam (confidence >= 0.7)
                      --> アーカイブ + _filtered/blocked ラベル + ブラックリスト自動追加
                          _filtered/processed ラベル付与
                          処理ログ記録（action: blocked_by_ai）
                      spam (confidence < 0.7) / legitimate / uncertain
                      --> 受信トレイに残す
                          _filtered/processed ラベル付与
                          処理ログ記録（action: kept_in_inbox）
```

## 判定ルール

| 状態 | 判定 | confidence | アクション |
|------|------|------------|-----------|
| 自社返信あり | legitimate | — | 受信トレイに残す（スパム判定スキップ） |
| ブラックリスト登録済み | spam | — | ゴミ箱に移動（AI判定なし） |
| AI判定 | spam | >= 0.7 | アーカイブ + `_filtered/blocked` + ブラックリスト自動追加 |
| AI判定 | spam | < 0.7 | 受信トレイに残す |
| AI判定 | legitimate | — | 受信トレイに残す |
| AI判定 | uncertain | — | 受信トレイに残す（安全側に倒す） |

## 分類基準の詳細

受信者の背景として、SES（システムエンジニアリングサービス）・人材紹介事業を運営する会社であることをプロンプトに含める。本文は先頭 2,000 文字に切り詰めて Gemini API に送信する。

### spam（営業メール・迷惑メール）

一方的な売り込みメールを spam と判定する。

- IT 製品・SaaS ツール・マーケティングサービス等の宣伝
- セミナー・ウェビナー・イベント・展示会の案内（主催・後援・協賛に関わらず）
- 資料送付の打診・ホワイトペーパーの案内
- 面談・商談・アポイントメントの一方的な依頼
- コンサルティング・広告・Web 制作・DX 推進等のサービス紹介
- AI・DX・デジタル化・業務改善に関するコンサルティングや導入提案
- 「御社の課題を解決」「業務効率化のご提案」等の定型句を含む一般的な提案メール
- 採用媒体・HR Tech・福利厚生サービス等の営業
- オフィス用品・回線・電力・不動産等の営業
- 一括送信されたと思われるテンプレート的なメール
- 受信者の SES・人材事業と無関係な商品やサービスの売り込み全般

### legitimate（正規のメール）

SES・人材ビジネスに直接関係する具体的なやり取り、および業務上必要な連絡を legitimate と判定する。

- SES 案件の紹介（案件名・スキル要件・単価・期間・勤務地など具体的な案件情報を含む）
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
- SES 関連に見えるが具体性に欠け判断が難しい場合
- 情報が不足しており判断できない場合

## ブラックリスト仕様

スプレッドシートの `Blacklist` シートで管理する。

| カラム | 内容 |
|--------|------|
| email | メールアドレス（正規化済み・小文字） |
| added_date | 追加日時（JST: `yyyy-MM-dd HH:mm:ss`） |
| source | 追加元（`auto`: AI 判定による自動追加 / `manual`: 手動追加） |

- AI 判定で spam かつ confidence >= 0.7 の場合に `auto` として自動登録される
- 登録済みアドレスからのメールは AI 判定を行わず即座にゴミ箱に移動する
- 誤登録した場合はスプレッドシートの該当行を手動で削除する

## ディレクトリ構成

```
gmail-spam-slayer/
├── src/
│   ├── main.gs         # エントリポイント・処理フロー制御・トリガー管理・初期化
│   ├── config.gs       # 定数・設定値（機密情報は Script Properties から取得）
│   ├── gmailClient.gs  # Gmail REST API ラッパー（取得・ラベル・アーカイブ・ゴミ箱移動）
│   ├── classifier.gs   # Gemini API によるメール判定（プロンプト構築・レスポンス解析）
│   ├── blacklist.gs    # ブラックリスト管理（スプレッドシート CRUD）
│   ├── logger.gs       # 処理ログ記録（スプレッドシート ProcessLog シート）
│   └── utils.gs        # ユーティリティ関数（メール正規化・HTML 除去・Base64 デコード等）
├── appsscript.json     # GAS マニフェスト（OAuth スコープ設定）
└── .clasp.json         # clasp 設定（スクリプト ID）
```

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

### 3. 初期化

GAS エディタで `initialize()` を手動実行する。以下の処理が一括で行われる。

- 必要な Gmail ラベル（`_filtered/blocked`, `_filtered/processed`）を作成する
- スプレッドシートに `Blacklist` シートと `ProcessLog` シートを作成する
- `GEMINI_API_KEY` と `SPREADSHEET_ID` が設定されているか確認し、未設定の場合はエラーログを出力して終了する

### 4. トリガーの設定

GAS エディタで `setupTrigger()` を手動実行する。`processEmails` の1日2回（午前10時・午後7時）トリガーが登録される。

| 関数 | 説明 |
|------|------|
| `setupTrigger()` | トリガーを登録（既存トリガーは削除してから再作成） |
| `removeTrigger()` | `processEmails` のトリガーをすべて削除 |

## 設定値一覧

`src/config.gs` の `CONFIG` オブジェクトで定義される全設定。

| 設定名 | 値 | 説明 |
|--------|----|------|
| `GEMINI_API_BASE` | `https://generativelanguage.googleapis.com/v1beta/models` | Gemini API のベース URL |
| `GEMINI_MODEL` | `gemini-2.5-flash` | 使用するモデル |
| `GEMINI_TEMPERATURE` | `0` | 生成温度（0 = 決定論的） |
| `GEMINI_MAX_TOKENS` | `1024` | 最大出力トークン数 |
| `API_CALL_DELAY_MS` | `500` | API 呼び出し間のスリープ（ms） |
| `API_RETRY_MAX` | `3` | API リトライ上限回数 |
| `API_RETRY_COOLDOWN_MS` | `5000` | リトライ待機時間（ms） |
| `EMAIL_BODY_MAX_LENGTH` | `2000` | 判定に渡す本文の最大文字数 |
| `TARGET_EMAIL` | `service@finn.co.jp` | フィルタリング対象のメールアドレス |
| `SPAM_CONFIDENCE_THRESHOLD` | `0.7` | アーカイブ実行の confidence 閾値 |
| `BLACKLIST_SHEET_NAME` | `Blacklist` | ブラックリストシート名 |
| `LOG_SHEET_NAME` | `ProcessLog` | ログシート名 |
| `LABEL_BLOCKED` | `_filtered/blocked` | 高確信度スパムに付与するラベル |
| `LABEL_PROCESSED` | `_filtered/processed` | 処理済みマーカーラベル |
| `GMAIL_API_BASE` | `https://www.googleapis.com/gmail/v1/users/me` | Gmail REST API のベース URL |
| `COMPANY_DOMAINS` | `['finn.co.jp', 'ex.finn.co.jp']` | 自社ドメイン（返信があるスレッドはスパム判定をスキップ） |

機密情報（`GEMINI_API_KEY` / `SPREADSHEET_ID`）は `CONFIG` に直接書かず、Script Properties から取得する。

## Gmail REST API を使う理由

GAS 内蔵の `GmailApp` には1日20,000回の読み取り制限がある。Gmail REST API を `UrlFetchApp` 経由で直接呼び出すことでこの日次制限を回避できる。レートリミットは秒単位（250 quota units/sec/user）のみとなる。認証は `ScriptApp.getOAuthToken()` で取得した OAuth トークンを `Authorization: Bearer` ヘッダーに付与して行う。
