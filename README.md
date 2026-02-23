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
  └── reviewBlacklist() 実行
  |     直近14日以内に追加されたブラックリストエントリを確認
  |     自社返信があるスレッドの送信元を自動解除
  |
  └── Gmail REST API で未処理メールを取得
        └── メールごとに以下を順番に実行
              |
              +-- [1] 自社返信チェック
              |       スレッドに @finn.co.jp / @ex.finn.co.jp からの返信あり
              |       （TARGET_EMAIL 自身の送信は自社返信としてカウントしない）
              |       --> スパム判定スキップ
              |           _filtered/processed ラベル付与
              |           受信トレイに残す
              |           処理ログ記録（classification: legitimate, action: skipped_company_reply）
              |
              +-- [2] ブラックリスト確認（自社返信なしの場合）
              |       登録済み
              |       --> アーカイブ + _filtered/blocked ラベル付与（AI判定なし）
              |           _filtered/processed ラベル付与
              |           処理ログ記録（action: blocked_by_blacklist）
              |
              +-- [3] Gemini API で AI 判定（ブラックリスト未登録の場合）
                      spam (confidence >= 0.6)
                      --> アーカイブ + _filtered/blocked ラベル + ブラックリスト自動追加
                          _filtered/processed ラベル付与
                          処理ログ記録（action: blocked_by_ai）
                      spam (confidence < 0.6) / legitimate
                      --> 受信トレイに残す
                          _filtered/processed ラベル付与
                          処理ログ記録（action: kept_in_inbox）
```

## 判定ルール

| 状態 | 判定 | confidence | アクション |
|------|------|------------|-----------|
| 自社返信あり | legitimate | — | 受信トレイに残す（スパム判定スキップ） |
| ブラックリスト登録済み | spam | — | アーカイブ + `_filtered/blocked`（AI判定なし） |
| AI判定 | spam | >= 0.6 | アーカイブ + `_filtered/blocked` + ブラックリスト自動追加 |
| AI判定 | spam | < 0.6 | 受信トレイに残す |
| AI判定 | legitimate | — | 受信トレイに残す |

## 分類基準の詳細

受信者の背景として、SES（システムエンジニアリングサービス）・人材紹介事業を運営する会社であることをプロンプトに含める。本文は先頭 2,000 文字に切り詰めて Gemini API に送信する。

Gemini API には二値分類（`is_legitimate: true / false`）で回答させ、以下の6項目のいずれか1つでも明確に該当する場合のみ `is_legitimate: true` とする。

### legitimate（正規のメール）の条件（6項目）

以下のいずれか1つでも明確に該当する場合を legitimate と判定する。

1. SES 案件に関する要員募集・案件紹介・要員提案（具体性の程度は問わない。案件一覧やスキルシート送付も含む）
2. 既存取引先からの業務連絡（請求・契約・納品等）
3. 利用中サービスからの重要通知（障害・セキュリティ・契約変更等）
4. 具体的なプロジェクト名や担当者名を挙げた要員提案・スカウト
5. 社内・取引先との進行中案件に関する連絡
6. 自社サービスや問い合わせフォームからの自動返信・受付確認メール

### spam（営業メール・迷惑メール）

上記6項目のいずれにも該当しないメールはすべて spam と判定する。

- 一方的な営業・宣伝・セミナー案内・ツール紹介・DX 提案・採用媒体営業・BPO 営業等はすべて spam

## ブラックリスト仕様

スプレッドシートの `Blacklist` シートで管理する。

| カラム | 内容 |
|--------|------|
| email | メールアドレス（正規化済み・小文字） |
| added_date | 追加日時（JST: `yyyy-MM-dd HH:mm:ss`） |
| source | 追加元（`auto`: AI 判定による自動追加 / `manual`: 手動追加） |

- AI 判定で spam かつ confidence >= 0.6 の場合に `auto` として自動登録される
- 登録済みアドレスからのメールは AI 判定を行わずアーカイブする
- 直近 `BLACKLIST_REVIEW_DAYS`（デフォルト 14 日）以内に追加されたエントリは自動解除の対象となる。自社返信があるスレッドの送信元が登録されていた場合、メール処理ループの前に実行される `reviewBlacklist()` によって自動的に解除される
- 誤登録した場合はスプレッドシートの該当行を手動で削除することもできる

## ディレクトリ構成

```
gmail-spam-slayer/
├── src/
│   ├── main.gs         # エントリポイント・処理フロー制御・トリガー管理・初期化
│   ├── config.gs       # 定数・設定値（機密情報は Script Properties から取得）
│   ├── gmailClient.gs  # Gmail REST API ラッパー（取得・ラベル・アーカイブ）
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
| `GEMINI_MAX_TOKENS` | `512` | 最大出力トークン数 |
| `API_CALL_DELAY_MS` | `500` | API 呼び出し間のスリープ（ms） |
| `API_RETRY_MAX` | `3` | API リトライ上限回数 |
| `API_RETRY_COOLDOWN_MS` | `5000` | リトライ待機時間（ms） |
| `EMAIL_BODY_MAX_LENGTH` | `2000` | 判定に渡す本文の最大文字数 |
| `TARGET_EMAIL` | `service@finn.co.jp` | フィルタリング対象のメールアドレス |
| `SPAM_CONFIDENCE_THRESHOLD` | `0.6` | アーカイブ実行の confidence 閾値 |
| `BLACKLIST_REVIEW_DAYS` | `14` | ブラックリスト自動解除の検査対象期間（日数） |
| `BLACKLIST_SHEET_NAME` | `Blacklist` | ブラックリストシート名 |
| `LOG_SHEET_NAME` | `ProcessLog` | ログシート名 |
| `LABEL_BLOCKED` | `_filtered/blocked` | 高確信度スパムに付与するラベル |
| `LABEL_PROCESSED` | `_filtered/processed` | 処理済みマーカーラベル |
| `GMAIL_API_BASE` | `https://www.googleapis.com/gmail/v1/users/me` | Gmail REST API のベース URL |
| `COMPANY_DOMAINS` | `['finn.co.jp', 'ex.finn.co.jp']` | 自社ドメイン（返信があるスレッドはスパム判定をスキップ） |

機密情報（`GEMINI_API_KEY` / `SPREADSHEET_ID`）は `CONFIG` に直接書かず、Script Properties から取得する。

## Gmail REST API を使う理由

GAS 内蔵の `GmailApp` には1日20,000回の読み取り制限がある。Gmail REST API を `UrlFetchApp` 経由で直接呼び出すことでこの日次制限を回避できる。レートリミットは秒単位（250 quota units/sec/user）のみとなる。認証は `ScriptApp.getOAuthToken()` で取得した OAuth トークンを `Authorization: Bearer` ヘッダーに付与して行う。
