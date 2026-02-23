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
├── main.gs            # エントリポイント・トリガー管理・処理フロー制御
├── config.gs          # 定数・設定値・スプレッドシートID等
├── gmailClient.gs     # Gmail REST API ラッパー（取得・ラベル・アーカイブ）
├── classifier.gs      # Gemini API によるメール判定
├── blacklist.gs       # ブラックリスト管理（スプレッドシート CRUD）
├── logger.gs          # 処理ログ記録（スプレッドシート）
└── utils.gs           # ユーティリティ関数
appsscript.json        # GAS マニフェスト
```

## 処理フロー
1. GAS トリガー起動（1日2回：午前10時・午後7時、1回最大50通）
2. Gmail REST API で未処理メールを取得
3. 送信元がブラックリストに存在するか確認
   - 存在 & 猶予期間外 → 即アーカイブ + `_filtered/blocked` ラベル
   - 存在 & 猶予期間内 → AI 判定へ（再評価）
   - 存在しない → AI 判定へ
4. Gemini API でメール内容を判定
5. 判定結果に基づくアクション:
   - spam (confidence ≥ 0.8) → アーカイブ + `_filtered/blocked` ラベル + ブラックリスト自動追加
   - spam (confidence < 0.8) → 受信トレイに残す + `_filtered/low_confidence` ラベル
   - legitimate / uncertain → 受信トレイに残す
6. 処理ログをスプレッドシートに記録

## 判定ルール
| 判定 | confidence | アクション |
|------|-----------|-----------|
| spam | ≥ 0.8 | アーカイブ + ブラックリスト追加 |
| spam | < 0.8 | 受信トレイに残す（ラベルのみ） |
| legitimate | — | 受信トレイに残す |
| uncertain | — | 受信トレイに残す（安全側） |

## ブラックリスト仕様
- スプレッドシートのシート `Blacklist` に保存
- カラム: email, added_date, last_confirmed_date, source (auto/manual)
- 登録後 30 日間は「猶予期間」として AI 再判定を実施
- 猶予期間中に legitimate 判定が出たら自動解除
- 猶予期間経過後は API を呼ばずに即アーカイブ（コスト削減）

## Gmail REST API の利用理由
GAS 内蔵の `GmailApp` は1日20,000回の読み取り制限がある。Gmail REST API を `UrlFetchApp` 経由で呼び出すことで日次制限を回避し、秒単位のレートリミット（250 quota units/sec/user）のみとなる。認証は `ScriptApp.getOAuthToken()` で取得。

## ラベル名
- `_filtered/blocked` — 高確信度スパムのアーカイブ用
- `_filtered/low_confidence` — 低確信度スパムの目印用
- `_filtered/processed` — 処理済みマーカー（重複処理防止）

## コーディング規約
- Google Apps Script (ES5 互換 + V8 ランタイムの一部 ES6 機能)
- const/let 使用可、アロー関数使用可（V8 ランタイム前提）
- JSDoc コメントで型情報を記載
- エラーハンドリング: try-catch で外部 API 呼び出しをラップし、失敗時はログ記録して処理を継続
- 1回の実行で最大50通を処理（GAS 6分制限対策）
