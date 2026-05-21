import { getRedis, withRedisRetry } from '../lib/redis.js';
import { buildDashboard } from '../lib/re-eye-report.js';

const KEY_ALL = 'reeye:reports:all';

function setNoStore(res) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  setNoStore(res);

  const q = (req.method === 'GET' ? req.query : req.body) || {};
  const limitRaw = Math.floor(Number(q.limit) || 200);
  const limit = Math.max(1, Math.min(500, limitRaw));

  let raw = [];
  try {
    const r = getRedis();
    raw = await withRedisRetry(() => r.lrange(KEY_ALL, 0, limit - 1), { label: 'dashboard-lrange' });
  } catch (e) {
    console.error('[dashboard] load failed:', e && e.message);
    raw = [];
  }

  const reports = (raw || [])
    .map((s) => safeJsonParse(s))
    .filter((x) => x && typeof x === 'object');

  const dashboard = buildDashboard(reports);
  // 返却形は固定: UI 側でこれ以上加工しない
  return res.status(200).json({
    brokenRanking: dashboard.brokenRanking || [],
    brandStats: dashboard.brandStats || [],
    sizeHeatmap: dashboard.sizeHeatmap || [],
    apiScores: dashboard.apiScores || [],
  });
}

