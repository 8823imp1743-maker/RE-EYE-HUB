/**
 * Firebase Cloud Functions エントリーポイント
 * 全 API ルートを Express でまとめ、単一の onRequest として公開する
 * 【金庫（Secret Manager）連携・完全版】
 */

import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import express from 'express';

// ── 金庫（Secret Manager）の鍵リスト ──────────────────────
// 監督がセキュリティ対策で隠した鍵の名前をここに登録します
const API_SECRETS = [
  "RAKUTEN_APP_ID",
  "RAKUTEN_ACCESS_KEY",
  "RAKUTEN_AFFILIATE_ID",
  "YAHOO_APP_ID",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

import chatHandler           from './functions/api/chat.js';
import pollHandler           from './functions/api/poll.js';
import pollStatusHandler     from './functions/api/poll-status.js';
import sourcesBaselineHandler from './functions/api/sources-baseline.js';
import ingestHandler         from './functions/api/webhook/ingest.js';
import categoriesHandler     from './functions/api/categories/index.js';
import categoriesRegisterHandler from './functions/api/categories/register.js';
import scoutHandler, { runScheduledScout } from './functions/api/scout.js';
import stockHandler          from './functions/api/stock.js';
import adminFlushHandler     from './functions/api/admin/flush.js';
import searchHandler         from './functions/api/search.js';
import monitorHandler, { checkAllWatched, checkAuctionPrices } from './functions/api/monitor.js';
import readerHandler         from './functions/api/reader.js';
import userSettingsHandler   from './functions/api/user-settings.js';
import trendHandler          from './functions/api/trend.js';

const app = express();
app.use(express.json());

// ── API ルーティング ──────────────────────────────────────
app.post('/api/chat',                chatHandler);
app.post('/api/poll',                pollHandler);
app.get( '/api/poll-status',         pollStatusHandler);
app.get( '/api/categories',          categoriesHandler);
app.post('/api/categories/register', categoriesRegisterHandler);
app.post('/api/webhook/ingest',      ingestHandler);
app.post('/api/scout',               scoutHandler);
app.get( '/api/scout',               scoutHandler);
app.post('/api/reader',              readerHandler);
app.post('/api/stock',               stockHandler);
app.post('/api/admin/flush',         adminFlushHandler);
app.post('/api/search',              searchHandler);
app.post('/api/monitor',             monitorHandler);
app.get( '/api/monitor',             monitorHandler);
app.get( '/api/user/settings',       userSettingsHandler);
app.post('/api/user/settings',       userSettingsHandler);
app.get( '/api/trend',               trendHandler);
app.post('/api/trend',               trendHandler);

app.post('/api/sources/:sourceId/baseline', (req, res) => {
  req.query = { ...req.query, sourceId: req.params.sourceId };
  sourcesBaselineHandler(req, res);
});

// ── Cloud Functions エクスポート ─────────────────────────

// 1. メインAPI (secrets を追加)
export const api = onRequest({ 
  region: 'asia-northeast1',
  secrets: API_SECRETS 
}, app);

// 2. 【VIP】在庫 Master Tick (1分ごと + Jitter / secrets を追加)
//    checkAllWatched() 内でプラン別インターバルを判定し VIP は 1〜3分間隔でリサーチを回す
export const stockWatchScheduler = onSchedule(
  {
    schedule: 'every 1 minutes',
    timeZone: 'Asia/Tokyo',
    region: 'asia-northeast1',
    secrets: API_SECRETS,
    maxInstances: 1,   // 多重起動防止 — 前の実行が終わるまで次を起動しない
  },
  async () => {
    console.log('[cron][VIP] stockMasterTick: 在庫監視 開始');
    try {
      await checkAllWatched();
      console.log('[cron][VIP] stockMasterTick: 完了');
    } catch(e) {
      console.error('[cron][VIP] stockMasterTick エラー:', e.message);
    }
  }
);

// 3. 【VIP】インテル・スカウター (2時間ごと / 深夜・早朝も不眠不休)
export const scoutScheduler = onSchedule(
  {
    schedule: '0 */2 * * *',
    timeZone: 'Asia/Tokyo',
    region: 'asia-northeast1',
    secrets: API_SECRETS,
    maxInstances: 1,   // 多重起動防止
  },
  async () => {
    console.log('[cron][VIP] scoutScheduler: インテル巡回 開始');
    const { items, errors } = await runScheduledScout();
    console.log(`[cron][VIP] scoutScheduler: 新着 ${items.length} 件 / エラー ${errors.length} 件`);
  }
);

// 4. オークション相場チェック (毎日9時 / secrets を追加)
export const auctionCheckScheduler = onSchedule(
  { 
    schedule: '0 9 * * *', 
    timeZone: 'Asia/Tokyo', 
    region: 'asia-northeast1',
    secrets: API_SECRETS
  },
  async () => {
    console.log('[cron] auctionCheckScheduler: オークション相場チェック開始');
    try {
      await checkAuctionPrices();
      console.log('[cron] auctionCheckScheduler: 完了');
    } catch(e) {
      console.error('[cron] auctionCheckScheduler エラー:', e.message);
    }
  }
);