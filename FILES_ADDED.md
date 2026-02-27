# 追加・編集したファイル一覧

## 新規作成

| ファイル | 説明 |
|----------|------|
| `package.json` | プロジェクト設定・@upstash/redis 依存 |
| `vercel.json` | Vercel 設定・baseline 用 rewrite |
| `.env.example` | 必要環境変数のテンプレート |
| `.gitignore` | node_modules, .env 等を除外 |
| `api/webhook/ingest.js` | POST /api/webhook/ingest（新着 ingest・通知） |
| `api/sources-baseline.js` | POST /api/sources/:sourceId/baseline（ベースライン作成） |
| `lib/filters.js` | 除外ワード・重要カテゴリ判定 |
| `lib/utils.js` | seen キー生成（sourceType 別正規化） |
| `lib/redis.js` | Upstash Redis クライアント |
| `lib/notification.js` | OneSignal REST API 送信 |
| `lib/response.js` | JSON レスポンス送信ヘルパー |
| `README.md` | デプロイ手順・curl 例 |
| `FILES_ADDED.md` | 本ファイル |
