import { getRedis, withRedisRetry, probeRedisGet } from '../lib/redis.js';
import { getCircuit } from '../lib/re-eye-circuit.js';
import { redisGuardStatus } from '../lib/redis-guard.js';
import { quotaStatus } from '../lib/quota-manager.js';

const HEALTH_LIST = 'reeye:health:events';

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
  const limit = Math.max(1, Math.min(1000, limitRaw));

  let raw = [];
  try {
    const r = getRedis();
    raw = await withRedisRetry(() => r.lrange(HEALTH_LIST, 0, limit - 1), { label: 'syshealth-lrange' });
  } catch {
    raw = [];
  }

  const entries = (raw || []).map(safeJsonParse).filter((x) => x && typeof x === 'object');
  const total = entries.length || 1;

  const avgScore = entries.reduce((s, e) => s + (Number(e.score) || 0), 0) / total;
  const criticalRate = entries.filter((e) => e.level === 'critical').length / total;

  const topFailQueries = entries
    .filter((e) => e.level && e.level !== 'ok')
    .slice(0, 300)
    .reduce((m, e) => {
      const q0 = String(e.query || '').trim();
      if (!q0) return m;
      m.set(q0, (m.get(q0) || 0) + 1);
      return m;
    }, new Map());
  const topFailQueriesOut = [...topFailQueries.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([query, count]) => ({ query, count }));

  const apiAgg = entries.reduce((m, e) => {
    const api = String(e.api || 'unknown').trim() || 'unknown';
    if (!m.has(api)) m.set(api, { api, total: 0, sum: 0, critical: 0 });
    const a = m.get(api);
    a.total++;
    a.sum += Number(e.score) || 0;
    if (e.level === 'critical') a.critical++;
    return m;
  }, new Map());

  const apiHealth = [...apiAgg.values()]
    .map((a) => ({
      api: a.api,
      avgScore: a.total ? a.sum / a.total : 0,
      criticalRate: a.total ? a.critical / a.total : 0,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);

  let circuitState = 'healthy';
  try {
    const r0 = getRedis();
    circuitState = await getCircuit(r0);
  } catch {
    /* ignore */
  }

  let redisProbe = null;
  if (String(q.redisProbe || '') === '1') {
    redisProbe = await probeRedisGet('re-eye:redis-probe');
  }

  return res.status(200).json({
    avgScore,
    criticalRate,
    topFailQueries: topFailQueriesOut,
    apiHealth,
    circuitState,
    ...(redisProbe ? { redisProbe } : {}),
    quota: {
      ...quotaStatus(),
      redis: redisGuardStatus(),
    },
    /** @deprecated 後方互換 — quota.redis と同一 */
    redisGuard: redisGuardStatus(),
  });
}

