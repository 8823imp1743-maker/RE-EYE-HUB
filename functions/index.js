/**
 * Firebase Cloud Functions エントリーポイント (V11)
 * 全 API ルートを Express でまとめ、単一の onRequest として公開する
 *
 * スケジューラー:
 *   stockWatchScheduler   — 毎1分起動（プラン別インターバル制御は monitor.js 側）
 *   scoutScheduler        — 毎時0分・6時間ごと（RSS 巡回）
 *   auctionCheckScheduler — 毎日 08:00 JST（ヤフオク相場確認）
 */

import { onRequest }  from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import express from 'express';

// ── API ハンドラー ──────────────────────────────────────────────────────────
import chatHandler              from './api/chat.js';
import pollHandler              from './api/poll.js';
import pollStatusHandler        from './api/poll-status.js';
import sourcesBaselineHandler   from './api/sources-baseline.js';
import ingestHandler            from './api/webhook/ingest.js';
import categoriesHandler        from './api/categories/index.js';
import categoriesRegisterHandler from './api/categories/register.js';
import scoutHandler, { runScheduledScout } from './api/scout.js';
import stockHandler             from './api/stock.js';
import searchHandler            from './api/search.js';
import monitorHandler, { checkAllWatched, checkAuctionPrices } from './api/monitor.js';
import trendHandler             from './api/trend.js';
import userSettingsHandler      from './api/user-settings.js';
import readerHandler            from './api/reader.js';
import flushHandler             from './api/admin/flush.js';

// ── Express アプリ ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── ルーティング ────────────────────────────────────────────────────────────
app.post('/api/chat',                    chatHandler);
app.post('/api/poll',                    pollHandler);
app.get( '/api/poll-status',             pollStatusHandler);
app.get( '/api/categories',             categoriesHandler);
app.post('/api/categories/register',     categoriesRegisterHandler);
app.post('/api/webhook/ingest',          ingestHandler);
app.post('/api/scout',                   scoutHandler);
app.get( '/api/scout',                   scoutHandler);
app.post('/api/stock',                   stockHandler);
app.post('/api/search',                  searchHandler);
app.post('/api/monitor',                 monitorHandler);
app.get( '/api/monitor',                 monitorHandler);
app.get( '/api/trend',                   trendHandler);
app.post('/api/trend',                   trendHandler);
app.get( '/api/user/settings',           userSettingsHandler);
app.post('/api/user/settings',           userSettingsHandler);
app.post('/api/reader',                  readerHandler);
app.post('/api/admin/flush',             flushHandler);

// Hosting rewrite で :sourceId を query に変換
app.post('/api/sources/:sourceId/baseline', (req, res) => {
  req.query = { ...req.query, sourceId: req.params.sourceId };
  sourcesBaselineHandler(req, res);
});

// ── Cloud Functions エクスポート ────────────────────────────────────────────

/** メイン API（Hosting rewrite → /api/** を受け取る） */
export const api = onRequest(
  {
    region:  'asia-northeast1',
    secrets: [
      'GEMINI_API_KEY',
      'ONESIGNAL_KEY',
      'ONESIGNAL_REST_KEY',
      'SERPAPI_KEY',
      'RAKUTEN_APP_ID',
      'RAKUTEN_AFFILIATE_ID',
      'YAHOO_APP_ID',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
    ],
  },
  app
);

/**
 * 在庫監視スケジューラー — 毎1分起動
 *
 * 実効監視間隔はプラン別インターバルで制御:
 *   VIP/PRO: 5分ごと + Jitter ±60s
 *   STANDARD: 15分ごと
 *   FREE: 60分ごと（昼のみ）
 */
export const stockWatchScheduler = onSchedule(
  {
    schedule:    'every 1 minutes',
    timeZone:    'Asia/Tokyo',
    region:      'asia-northeast1',
    secrets: [
      'GEMINI_API_KEY',
      'ONESIGNAL_KEY',
      'ONESIGNAL_REST_KEY',
      'SERPAPI_KEY',
      'RAKUTEN_APP_ID',
      'RAKUTEN_AFFILIATE_ID',
      'YAHOO_APP_ID',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
    ],
  },
  async () => {
    console.log('[cron] stockWatchScheduler: SERP監視サイクル開始');
    try {
      await checkAllWatched();
      console.log('[cron] stockWatchScheduler: 完了');
    } catch(e) {
      console.error('[cron] stockWatchScheduler 例外:', e.message);
    }
  }
);

/**
 * インテル・スカウター — 6時間ごとに RSS 巡回
 * Deep Recon: 60日分の記事をスキャン
 */
export const scoutScheduler = onSchedule(
  {
    schedule:    '0 */6 * * *',
    timeZone:    'Asia/Tokyo',
    region:      'asia-northeast1',
    secrets: [
      'GEMINI_API_KEY',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
    ],
  },
  async () => {
    console.log('[cron] scoutScheduler: インテル巡回開始（Deep Recon 60Days）');
    try {
      const { items, errors } = await runScheduledScout();
      console.log(`[cron] scoutScheduler: 新着 ${items.length} 件 / エラー ${errors.length} 件`);
    } catch(e) {
      console.error('[cron] scoutScheduler 例外:', e.message);
    }
  }
);

/**
 * ヤフオク相場チェッカー — 毎日 08:00 JST
 * 定価超えの相場シグナルを検知してユーザーに通知する
 */
export const auctionCheckScheduler = onSchedule(
  {
    schedule:    '0 8 * * *',
    timeZone:    'Asia/Tokyo',
    region:      'asia-northeast1',
    secrets: [
      'GEMINI_API_KEY',
      'ONESIGNAL_KEY',
      'ONESIGNAL_REST_KEY',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
    ],
  },
  async () => {
    console.log('[cron] auctionCheckScheduler: ヤフオク相場チェック開始');
    try {
      await checkAuctionPrices();
      console.log('[cron] auctionCheckScheduler: 完了');
    } catch(e) {
      console.error('[cron] auctionCheckScheduler 例外:', e.message);
    }
  }
);
