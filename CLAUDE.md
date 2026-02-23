# Gmail Spam Slayer

## プロジェクト概要
`service@finn.co.jp` に届く一方的な営業メールを、Google Apps Script（GAS）+ Gmail REST API + Gemini API で自動判定・フィルタリングするシステム。

## 技術スタック
- **実行基盤**: Google Apps Script（1日2回（午前10時・午後7時）トリガー）
- **メール操作**: Gmail REST API（`UrlFetchApp.fetch()` + OAuth トークン）
- **AI 判定**: Gemini API `gemini-2.5-flash`（temperature: 0、無料枠）
- **データ保存**: Google Spreadsheet（ブラックリスト + 処理ログ）

## ディレクトリ構成
```
src/
├── main.gs            # エントリポイント・トリガー管理・処理フロー制御・初期化
├── config.gs          # 定数・設定値・スプレッドシートID等
├── gmailClient.gs     # Gmail REST API ラッパー（取得・ラベル・アーカイブ）
├── classifier.gs      # Gemini API によるメール判定
├── blacklist.gs       # ブラックリスト管理（スプレッドシート CRUD）
├── logger.gs          # 処理ログ記録（スプレッドシート）
└── utils.gs           # ユーティリティ関数
appsscript.json        # GAS マニフェスト
```

## 処理フロー
1. GAS トリガー起動（1日2回：午前10時・午後7時、GAS実行時間制限（6分）に基づく時間ベース制御で5分経過時に安全終了）
2. Gmail REST API で未処理メールを取得
3. スレッド内に自社ドメイン（`@finn.co.jp` / `@ex.finn.co.jp`）からの返信があるか確認
   - あり → スパム判定をスキップ・`_filtered/processed` ラベルのみ付与・受信トレイに残す
   - なし → 次のステップへ
4. 送信元がブラックリストに存在するか確認
   - 存在する → 即ゴミ箱に移動（AI判定なし）+ `_filtered/processed` ラベル + ログ記録
   - 存在しない → AI 判定へ
5. Gemini API でメール内容を判定
6. 判定結果に基づくアクション:
   - spam (confidence ≥ 0.7) → アーカイブ + `_filtered/blocked` ラベル + ブラックリスト自動追加
   - spam (confidence < 0.7) / legitimate / uncertain → 受信トレイに残す
7. 処理ログをスプレッドシートに記録

## 判定ルール
| 判定 | confidence | アクション |
|------|-----------|-----------|
| spam | ≥ 0.7 | アーカイブ + ブラックリスト追加 |
| spam | < 0.7 | 受信トレイに残す |
| legitimate | — | 受信トレイに残す |
| uncertain | — | 受信トレイに残す |

## ブラックリスト仕様
- スプレッドシートのシート `Blacklist` に保存
- カラム: email, added_date, source (auto/manual)
- ブラックリスト登録済みのメールは内容を精査せず即座にゴミ箱に移動する（AI判定なし）
- 猶予期間は現在無効（`BLACKLIST_GRACE_PERIOD_DAYS` は将来の復活に備えて config に残存）

## Gmail REST API の利用理由
GAS 内蔵の `GmailApp` は1日20,000回の読み取り制限がある。Gmail REST API を `UrlFetchApp` 経由で呼び出すことで日次制限を回避し、秒単位のレートリミット（250 quota units/sec/user）のみとなる。認証は `ScriptApp.getOAuthToken()` で取得。

## ラベル名
- `_filtered/blocked` — スパムのアーカイブ用
- `_filtered/processed` — 処理済みマーカー（重複処理防止）

## コーディング規約
- Google Apps Script (ES5 互換 + V8 ランタイムの一部 ES6 機能)
- const/let 使用可、アロー関数使用可（V8 ランタイム前提）
- JSDoc コメントで型情報を記載
- エラーハンドリング: try-catch で外部 API 呼び出しをラップし、失敗時はログ記録して処理を継続
- 実行時間ベース制御: GAS 6分制限に対して5分（300,000ms）経過で安全に処理を終了（`MAX_EXECUTION_MS`）
