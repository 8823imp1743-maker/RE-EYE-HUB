# RE-EYE-HUB

> **欲しい商品、気づいたら終わってた。を防ぐ。**

争奪戦商品の「発見 → 見守り → 通知」アシスタント。
URLを知らなくていい。キーワードだけ入れれば、あとはシステムが探す。

---

## 何が違うか

| サービス | 特徴 |
|----------|------|
| Distill | URLを知っている人向けの監視 |
| **RE-EYE-HUB** | **URLを知らない人向けの発見＋監視** |

キーワード → システムが RSS・楽天・Yahoo から URL を発見 → 自動で監視 → 在庫復活・再販で通知。

---

## 対応カテゴリ

| カテゴリ | 監視モード |
|----------|-----------|
| スニーカー | **Sneaker Precision Mode**（PDP解析・cm単位サイズ確認） |
| ちいかわ / サンリオ / キャラクターグッズ | Standard Mode（在庫変化・再販検知） |
| 限定コスメ | Standard Mode |
| フィギュア / ガンプラ / ポケカ | Standard Mode |
| 推し活グッズ | Standard Mode |

---

## アーキテクチャ

```
User Input (keyword only)
        ↓
Canonical Product Engine   ← AJ1 = Air Jordan 1 = Jordan1 を同一視
        ↓
Signal Detection Layer
  ├── RSS (Google News)    ← 再販・発売シグナルの熱量検出
  ├── 楽天 API             ← 監視対象 URL 収集
  └── Yahoo API            ← 監視対象 URL 収集
        ↓
URL Quality Layer
  ├── 品質スコアリング     ← /item/ +30、/search/ -50
  ├── URL 正規化           ← トラッキングパラメータ除去
  └── Negative Signal      ← 「予約終了」「完売」は通知しない
        ↓
Adaptive Monitor
  ├── sneaker mode         ← PDP解析・cm厳密判定（isShoe=true 時のみ）
  ├── standard mode        ← 軽量HTML在庫変化（×2倍インターバル）
  └── cold item            ← 7日変化なし → ×4倍インターバル
        ↓
OneSignal Push Notification（dedup 4時間）
```

---

## 技術スタック

| レイヤー | 技術 |
|----------|------|
| API | Vercel Serverless（Node.js 20、ESM） |
| Frontend | Firebase Hosting（Vanilla JS SPA） |
| DB / KV | Upstash Redis |
| 通知 | OneSignal |
| 検索 | 楽天市場 API、Yahoo!ショッピング API |
| Discovery | Google News RSS |

---

## API エンドポイント（単一ルーター）

全エンドポイントは `POST /api/index?action=<name>` に統合（Vercel Hobby 12関数制限対応）。

| action | 説明 |
|--------|------|
| `discover` | キーワード → URL発見 → monitor 自動登録 |
| `monitor` | 見守り登録 / 一覧取得 / 削除 |
| `search` | 在庫リアルタイム検索 |
| `scout` | RSS深層スキャン（60日） |
| `poll` | 監視アイテムの状態ポーリング |
| `cron` | GitHub Actions から呼ばれる定期実行 |
| `system-health` | Redis・quota 状態確認 |

---

## 環境変数

| 変数名 | 用途 |
|--------|------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis |
| `RAKUTEN_APP_ID` | 楽天市場 API |
| `RAKUTEN_AFFILIATE_ID` | 楽天アフィリエイト |
| `YAHOO_APP_ID` | Yahoo!ショッピング API |
| `ONESIGNAL_APP_ID` | OneSignal |
| `ONESIGNAL_API_KEY` | OneSignal |
| `GEMINI_API_KEY` | Gemini（開発者専用ログ解析） |
| `CRON_SECRET` | GitHub Actions cron 認証 |
| `SENTRY_DSN` | エラー監視（任意） |

---

## デプロイ

```bash
# API（Vercel） — git push で自動デプロイ
git push origin main

# Frontend（Firebase Hosting）
firebase deploy --only hosting
```

---

## 開発方針

- **AI はユーザー機能に使わない**。開発者専用のバグ学習・ログ解析のみ。
- **RSS優先**。常時Google検索禁止（BAN・コスト・CPU）。
- **Vercel Hobby 無料枠で維持可能**な構成を維持する。
- **削除ではなく分離**。Sneaker Precision Module は残す。
