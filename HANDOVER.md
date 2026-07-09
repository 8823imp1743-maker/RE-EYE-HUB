# RE-EYE-HUB プロジェクト引き継ぎドキュメント

最終更新：2026-07-10

## プロジェクト概要

在庫復活を自動監視してプッシュ通知するWebアプリ。
楽天・Yahoo全店舗を横断監視する。特定店舗だけでなく
どの店舗で入荷しても通知が来る。

## URL

- 本番：https://re-eye-hub.vercel.app
- GitHub：https://github.com/8823imp1743-maker/RE-EYE-HUB

## 技術スタック

- UI: `public/index.html`（バニラJS・11px美学）
- API: `api/index.js` → `functions/api/*`
- Redis: Upstash（promoted-gelding-96892.upstash.io）
- Cron: cron-job.org（30分ごと・無料）
- Push通知: OneSignal（App ID: `ccbbc3f3-1dcd-4fdc-9a49-cbc332b7c4ce`）
- ホスティング: Vercel（無料・Hobbyプラン）
- 楽天API・Yahoo API（無料）

## 運用コスト

全て無料。自分1人で使う限り0円。

## Cronの構成

- cron-job.orgのみ使用（30分ごと）
- Vercel内蔵Cronは削除済み
- GitHub Actions scheduleは無効化済み
- エンドポイント：`https://re-eye-hub.vercel.app/api/cron`
- 認証：`Authorization: Bearer [CRON_SECRET]`

## 環境変数（Vercel）

- `RAKUTEN_APP_ID` / `RAKUTEN_ACCESS_KEY` / `RAKUTEN_AFFILIATE_ID`
- `YAHOO_APP_ID`
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
- `ONESIGNAL_APP_ID`（`ccbbc3f3-1dcd-4fdc-9a49-cbc332b7c4ce`）
- `ONESIGNAL_API_KEY`
- `CRON_SECRET`（cron-job.orgのヘッダーと同じ値）
- `GEMINI_API_KEY`（後回し・今は使わない）

## 監視の仕組み

1. ユーザーが商品を検索して「見守りに追加」を押す
2. Redisにkeyword・品番・色・サイズを保存
3. cron-job.orgが30分ごとに`/api/cron`を叩く
4. `checkAllWatched()`がkeywordで楽天・Yahoo全体を再検索
5. 品番+色+サイズ（`evaluateAttributeGate`）が一致したら通知
6. OneSignal経由でiPhone・PCにプッシュ通知

## 通知の仕組み

- OneSignal購読者：現在2人（自分のiPhone・PC）
- iPhone：PWA（ホーム画面に追加）で通知許可済み
- テスト通知：`/api/test-notify` で送信可能

## 動作確認済み

- 楽天・Yahoo横断検索：✅
- 見守り登録・削除：✅
- Redis接続：✅
- Cron自動監視（30分ごと）：✅
- OneSignal購読：✅
- iPhoneへのプッシュ通知：実機確認済み ✅

## 未対応・後回し

- PRO/VIP表示の「5分間隔」バグ（表示だけ間違い）
- ホーム/見守り/履歴の3画面データ不整合リスク
- Amazonの監視（将来対応予定）
- 課金・プラン機能の実装

## 重要なルール（コスト憲法）

- 無料枠最優先
- AIは開発者のみ使用（ユーザーには使わせない）
- Gemini APIは今は使わない
- `index.html`のデザイン（11px美学）は変更禁止

## デプロイ方法

```bash
cd C:\Users\imp1743\Desktop\RE-EYE-HUB
vercel --prod
```

## 週次チェック（5分）

1. Vercel Dashboard → Usage（80%未満か）
2. Upstash Console → Daily commands
3. OneSignal → Subscribers数
4. cron-job.org → 成功しているか
