/**
 * Firebase Cloud Functions v2 — HTTP 関数 `api`（Express に各ハンドラをマウント）
 * 旧スタブ廃止。/api/* と同パス（プレフィックスなし）の両方を受ける。
 */
import express from 'express';
import { onRequest } from 'firebase-functions/v2/https';

import searchHandler from './api/search.js';
import monitorHandler from './api/monitor.js';
import trendHandler from './api/trend.js';
import stockHandler from './api/stock.js';
import pollHandler from './api/poll.js';
import pollStatusHandler from './api/poll-status.js';
import scoutHandler from './api/scout.js';
import chatHandler from './api/chat.js';
import webhookIngestHandler from './api/webhook/ingest.js';
import sourcesBaselineHandler from './api/sources-baseline.js';
import categoriesIndexHandler from './api/categories/index.js';
import categoriesRegisterHandler from './api/categories/register.js';
import adminFlushHandler from './api/admin/flush.js';
import readerHandler from './api/reader.js';
import userSettingsHandler from './api/user-settings.js';
import ctrClickHandler from './api/ctr-click.js';
import notifyHealthHandler from './api/notify-health.js';
import reportsHandler from './api/reports.js';
import dashboardHandler from './api/dashboard.js';
import systemHealthHandler from './api/system-health.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

/** @param {string} pathFromApi 例: "/search" → /api/search と /search の両方 */
function mountApiPath(pathFromApi, handler) {
  const p = pathFromApi.startsWith('/') ? pathFromApi : `/${pathFromApi}`;
  app.all(`/api${p}`, (req, res) => handler(req, res));
  app.all(p, (req, res) => handler(req, res));
}

mountApiPath('/search', searchHandler);
mountApiPath('/monitor', monitorHandler);
mountApiPath('/trend', trendHandler);
mountApiPath('/stock', stockHandler);
mountApiPath('/poll', pollHandler);
mountApiPath('/poll-status', pollStatusHandler);
mountApiPath('/scout', scoutHandler);
mountApiPath('/chat', chatHandler);
mountApiPath('/webhook/ingest', webhookIngestHandler);
mountApiPath('/sources/baseline', sourcesBaselineHandler);
mountApiPath('/categories', categoriesIndexHandler);
mountApiPath('/categories/register', categoriesRegisterHandler);
mountApiPath('/admin/flush', adminFlushHandler);
mountApiPath('/reader', readerHandler);
mountApiPath('/user-settings', userSettingsHandler);
mountApiPath('/ctr-click', ctrClickHandler);
mountApiPath('/notify-health', notifyHealthHandler);
mountApiPath('/reports', reportsHandler);
mountApiPath('/dashboard', dashboardHandler);
mountApiPath('/system-health', systemHealthHandler);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

export const api = onRequest({ region: 'asia-northeast1', cors: true }, app);

/** ESM では CJS の `exports` が無いため、デバッグ用に同名オブジェクトを束縛 */
const exports = { api };
console.log("[DEBUG] api function exported:", !!exports.api);

// deploy update: 2026-04-28-v2
