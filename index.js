/**
 * Firebase Cloud Functions エントリーポイント
 * 全 API ルートを Express でまとめ、単一の onRequest として公開する
 */

import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import express from 'express';

import chatHandler           from './api/chat.js';
import pollHandler           from './api/poll.js';
import pollStatusHandler     from './api/poll-status.js';
import sourcesBaselineHandler from './api/sources-baseline.js';
import ingestHandler         from './api/webhook/ingest.js';
import categoriesHandler     from './api/categories/index.js';
import categoriesRegisterHandler from './api/categories/register.js';
import scoutHandler, { runScheduledScout } from './api/scout.js';
import stockHandler          from './api/stock.js';

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
app.post('/api/stock',               stockHandler);

// Vercel rewrite で :sourceId を query に変換していた箇所を Express params で吸収
app.post('/api/sources/:sourceId/baseline', (req, res) => {
  req.query = { ...req.query, sourceId: req.params.sourceId };
  sourcesBaselineHandler(req, res);
});

// ── Cloud Functions エクスポート ─────────────────────────
// Hosting rewrite の function 名と一致させる ("api")
export const api = onRequest({ region: 'asia-northeast1' }, app);

// Vercel cron (0 8 * * *) の代替: 毎日 08:00 JST に実行
export const dailyPollStatus = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'Asia/Tokyo', region: 'asia-northeast1' },
  async () => {
    console.log('[cron] dailyPollStatus: 定期ステータスチェック実行');
  }
);

// インテル・スカウター: 6時間ごとに RSS 巡回（Jitter 内蔵）
export const scoutScheduler = onSchedule(
  { schedule: '0 */6 * * *', timeZone: 'Asia/Tokyo', region: 'asia-northeast1' },
  async () => {
    console.log('[cron] scoutScheduler: インテル巡回開始');
    const { items, errors } = await runScheduledScout();
    console.log(`[cron] scoutScheduler: 新着 ${items.length} 件 / エラー ${errors.length} 件`);
  }
);
