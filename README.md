# RE-EYE-HUB マルチソース型新着通知エンジン

**取り逃がし防止装置** — 人が探しに行かなくても、間に合うタイミングで「新情報だけ」を受け取れる通知エンジン。

Yahoo!ショッピング風のカテゴリ選択UIを参考に、以下の差別化を実装しています。

- **マルチソース**：カテゴリごとに EC / 公式サイト / X / ファンクラブ をまとめて監視
- **タイムゼロ・ベースライン**：登録した瞬間に存在した情報は既読とし、それ以降の更新のみ通知
- **CTA（行動喚起）フィルタ**：「予約開始」「抽選受付」「本日締切」などに [重要] タグを付けて優先通知
- **SNS正規化**：X / Instagram の投稿を Webニュースと同じフォーマット（タイトル・本文・リンク）に変換

---

## API 一覧

| エンドポイント | 説明 |
|----------------|------|
| `GET /api/categories` | カテゴリツリー取得（UI用） |
| `POST /api/categories/register` | カテゴリ＋ソース登録 & タイムゼロ・ベースライン |
| `POST /api/sources/:sourceId/baseline` | 既存ソースのベースライン作成 |
| `POST /api/webhook/ingest` | 新着 ingest（外部Webhook受信） |

---

## 必要環境変数

| 変数名 | 説明 |
|--------|------|
| `WEBHOOK_SECRET` | X-Webhook-Secret ヘッダと照合。必須 |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST Token |
| `ONESIGNAL_APP_ID` | OneSignal アプリ ID |
| `ONESIGNAL_API_KEY` | OneSignal REST API Key |

`.env.example` をコピーして `.env` を作成し、値を設定してください。

---

## セットアップ

```bash
npm install
```

## Vercel へのデプロイ

### 1. Vercel にデプロイ

```bash
# Vercel CLI が未導入の場合
npm i -g vercel

# プロジェクトルートで
vercel
```

または [vercel.com](https://vercel.com) でリポジトリをインポートしてデプロイ。

### ローカルで確認する場合

```bash
# .env に環境変数を設定後
vercel dev
```

### 2. 環境変数を設定

Vercel ダッシュボード: **Project → Settings → Environment Variables** で次を追加：

- `WEBHOOK_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `ONESIGNAL_APP_ID`
- `ONESIGNAL_API_KEY`

### 3. OneSignal でテスト購読

1. [OneSignal](https://onesignal.com) でアプリを作成
2. ブラウザでワンクリック購読ページを開き、通知を許可
3. これで「自分だけ通知テスト」が可能

---

## 動作確認（curl）

デプロイ後、`https://your-app.vercel.app` を実際のURLに置き換えて実行してください。

### 共通オプション

- `YOUR_URL` = デプロイ後のベースURL（例: `https://re-eye-hub.vercel.app`）
- `YOUR_SECRET` = `WEBHOOK_SECRET` に設定した文字列

---

### 1. ベースライン作成（過去アイテムを「既読」にする）

```bash
curl -X POST "https://YOUR_URL/api/sources/test-source/baseline" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: YOUR_SECRET" \
  -d '{
    "userId": "test-user",
    "sourceId": "test-source",
    "sourceType": "web",
    "items": [
      {
        "id": "item-001",
        "title": "既存の商品のお知らせ",
        "url": "https://example.com/item-001",
        "publishedAt": "2025-01-01T00:00:00Z",
        "body": "これは既に存在するアイテムです"
      }
    ]
  }'
```

**期待レスポンス例:**

```json
{"ok":true,"sourceId":"test-source","baseline":{"marked":1}}
```

---

### 2. 新着 ingest（新着のみ通知される）

```bash
curl -X POST "https://YOUR_URL/api/webhook/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: YOUR_SECRET" \
  -d '{
    "userId": "test-user",
    "sourceId": "test-source",
    "sourceType": "web",
    "items": [
      {
        "id": "item-001",
        "title": "既存の商品のお知らせ",
        "url": "https://example.com/item-001",
        "publishedAt": "2025-01-01T00:00:00Z",
        "body": "既読済みなので通知されない"
      },
      {
        "id": "item-002",
        "title": "【予約開始】新商品の予約受付開始",
        "url": "https://example.com/item-002",
        "publishedAt": "2025-02-22T10:00:00Z",
        "body": "新商品の予約が本日より開始しました"
      }
    ]
  }'
```

**期待動作:**

- `item-001` はベースライン済み → **通知されない**
- `item-002` は新着 → **「予約/受付開始」カテゴリで通知される**

---

### 3. 除外ワードの確認（コンサート系は通知されない）

```bash
curl -X POST "https://YOUR_URL/api/webhook/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: YOUR_SECRET" \
  -d '{
    "userId": "test-user",
    "sourceId": "test-source",
    "sourceType": "web",
    "items": [
      {
        "id": "live-001",
        "title": "LIVE ツアー チケット販売",
        "url": "https://example.com/live",
        "publishedAt": "2025-02-22T12:00:00Z",
        "body": "会場・開演時間のお知らせ"
      }
    ]
  }'
```

**期待動作:** 除外ワード（LIVE/ツアー/チケット/会場/開演）を含むため **通知されない**。

---

### 4. 重要カテゴリの確認（再販/在庫復活など）

```bash
curl -X POST "https://YOUR_URL/api/webhook/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: YOUR_SECRET" \
  -d '{
    "userId": "test-user",
    "sourceId": "test-source",
    "sourceType": "web",
    "items": [
      {
        "id": "restock-001",
        "title": "在庫復活のお知らせ",
        "url": "https://example.com/restock",
        "publishedAt": "2025-02-22T14:00:00Z",
        "body": "数量限定で再入荷しました"
      }
    ]
  }'
```

**期待動作:** 「再販/在庫復活」カテゴリで **通知される**。

---

## 5. カテゴリ登録（マルチソース + タイムゼロ・ベースライン）

```bash
curl -X POST "https://YOUR_URL/api/categories/register" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user",
    "categoryId": "game",
    "sources": [
      { "type": "web", "sourceId": "official-news", "name": "公式サイト" },
      { "type": "x", "sourceId": "brand-x", "name": "公式X" }
    ],
    "baselineItems": [
      {
        "sourceId": "official-news",
        "sourceType": "web",
        "items": [
          { "id": "old-001", "title": "既存ニュース", "url": "https://example.com/1", "body": "登録前の情報" }
        ]
      }
    ]
  }'
```

**期待動作:** 登録時点の全アイテムが既読化され、以降の更新のみ通知対象になる。

---

## 受け入れ条件の確認フロー

1. **baseline** または **categories/register** 実行 → 既存アイテムを既読化（タイムゼロ）
2. **ingest** で既読アイテム＋新着を送る → 新着のみ通知
3. 同じ **ingest** を再度実行 → 同じアイテムは二度通知されない
4. **LIVE/TOUR 等** を含むアイテム → 通知されない
5. **予約開始/抽選受付/本日締切** を含むアイテム → **[重要]** タグ付きで通知される
6. **X/Instagram** の生データ → 正規化されて同じフォーマットで通知される

---

## ファイル構成

```
RE-EYE-HUB/
├── api/
│   ├── categories/
│   │   ├── index.js           # GET /api/categories
│   │   └── register.js        # POST /api/categories/register
│   ├── webhook/
│   │   └── ingest.js          # POST /api/webhook/ingest
│   └── sources-baseline.js    # POST /api/sources/:sourceId/baseline
├── lib/
│   ├── categories.js          # カテゴリ・マルチソースモデル
│   ├── filters.js             # 除外・CTA（[重要]）判定
│   ├── sns-normalizer.js      # X/Instagram → {title, body, url} 正規化
│   ├── notification.js        # OneSignal 送信
│   ├── redis.js               # Upstash Redis
│   ├── response.js            # JSON レスポンスヘルパー
│   └── utils.js               # seen キー生成
├── .env.example
├── package.json
├── vercel.json
└── README.md
```
