# Gmail Spam Slayer

`service@finn.co.jp` に届く一方的な営業メールを、Google Apps Script + Gmail REST API + Gemini API で自動判定・フィルタリングするシステム。

---

## 技術スタック

- **実行基盤**: Google Apps Script（1時間間隔トリガー、V8 ランタイム）
- **メール操作**: Gmail REST API（`UrlFetchApp.fetch()` + OAuth トークン）
- **AI 判定**: Gemini API `gemini-2.5-flash`（temperature: 0）
- **データ保存**: Google Spreadsheet（ブラックリスト + 処理ログ）

---

## 処理フロー

```
トリガー起動（1時間間隔）
  |
  +-- Gmail REST API で未処理メールを取得（最大50通）
        |
        +-- [送信元がブラックリスト登録済み & 猶予期間外]
        |     --> ゴミ箱に移動（削除）+ _filtered/processed ラベル付与
        |
        +-- [送信元がブラックリスト登録済み & 猶予期間内]
        |     --> Gemini API で AI 判定
        |         legitimate 判定 --> ブラックリストから自動解除
        |
        +-- [送信元がブラックリスト未登録]
              --> Gemini API で AI 判定
                  |
                  +-- spam (confidence >= 0.8)
                  |     --> アーカイブ + _filtered/blocked ラベル + ブラックリスト自動追加
                  +-- spam (confidence < 0.8)
                  |     --> _filtered/low_confidence ラベルのみ付与
                  +-- legitimate / uncertain
                        --> 受信トレイに残す
```

処理後、全メールに `_filtered/processed` ラベルを付与し、重複処理を防ぐ。

---

## 判定ルール

| 判定 | confidence | アクション |
|------|------------|-----------|
| spam | >= 0.8 | アーカイブ + `_filtered/blocked` ラベル + ブラックリスト自動追加 |
| spam | < 0.8 | `_filtered/low_confidence` ラベルのみ（受信トレイに残す） |
| legitimate | — | 受信トレイに残す |
| uncertain | — | 受信トレイに残す（安全側に倒す） |
| ブラックリスト（猶予期間外） | — | ゴミ箱に移動（削除） |

---

## ブラックリスト仕様

スプレッドシートの `Blacklist` シートで管理する。

| カラム | 内容 |
|--------|------|
| email | メールアドレス |
| added_date | ブラックリスト追加日 |
| last_confirmed_date | 最終確認日 |
| source | 追加元（`auto` / `manual`） |

**猶予期間（30日間）の動作:**

- 登録後30日以内は AI 再判定を実施する
- 猶予期間中に `legitimate` 判定が出た場合、ブラックリストから自動解除する

**猶予期間経過後の動作:**

- Gemini API を呼び出さずにゴミ箱へ移動する（API コスト削減）
- `last_confirmed_date` を更新する

---

## ディレクトリ構成

```
gmail-spam-slayer/
├── src/
│   ├── main.gs         # エントリポイント・処理フロー制御・トリガー管理
│   ├── config.gs       # 定数・設定値（スプレッドシートID等はScript Propertiesから取得）
│   ├── gmailClient.gs  # Gmail REST API ラッパー（取得・ラベル・アーカイブ・ゴミ箱移動）
│   ├── classifier.gs   # Gemini API によるメール判定（プロンプト構築・レスポンス解析）
│   ├── blacklist.gs    # ブラックリスト管理（スプレッドシート CRUD）
│   ├── logger.gs       # 処理ログ記録（スプレッドシート ProcessLog シート）
│   └── utils.gs        # ユーティリティ関数（メール正規化・日付計算等）
├── appsscript.json     # GAS マニフェスト（OAuth スコープ設定）
└── .clasp.json         # clasp 設定（スクリプトID）
```

---

## セットアップ手順

### 1. clasp でデプロイ

```bash
# 依存パッケージのインストール（初回のみ）
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

GAS エディタで `setupTrigger()` を実行すると、`processEmails` の1時間間隔トリガーが登録される。

```
setupTrigger()   # トリガーを登録
removeTrigger()  # トリガーを削除（停止したい場合）
```

---

## 設定値一覧

`src/config.gs` の主要設定。

| 設定名 | デフォルト値 | 説明 |
|--------|-------------|------|
| `GEMINI_MODEL` | `gemini-2.5-flash` | 使用する Gemini モデル |
| `GEMINI_TEMPERATURE` | `0` | 応答の確定性（0 = 最大確定） |
| `GEMINI_MAX_TOKENS` | `1024` | 最大出力トークン数 |
| `MAX_EMAILS_PER_RUN` | `50` | 1回の実行で処理する最大メール数 |
| `EMAIL_BODY_MAX_LENGTH` | `2000` | 判定に使う本文の最大文字数 |
| `TARGET_EMAIL` | `service@finn.co.jp` | フィルタリング対象のメールアドレス |
| `SPAM_CONFIDENCE_THRESHOLD` | `0.8` | アーカイブ判定の確信度閾値 |
| `BLACKLIST_GRACE_PERIOD_DAYS` | `30` | ブラックリスト猶予期間（日数） |
| `API_CALL_DELAY_MS` | `500` | API 呼び出し間のスリープ（ms） |
| `API_RETRY_MAX` | `3` | API リトライ上限回数 |
| `API_RETRY_COOLDOWN_MS` | `5000` | リトライ待機時間（ms） |

---

## Gmail REST API を使う理由

GAS 内蔵の `GmailApp` には1日20,000回の読み取り制限がある。Gmail REST API を `UrlFetchApp` 経由で直接呼び出すことでこの日次制限を回避できる。レートリミットは秒単位（250 quota units/sec/user）のみとなる。認証は `ScriptApp.getOAuthToken()` で取得した OAuth トークンを使用する。
