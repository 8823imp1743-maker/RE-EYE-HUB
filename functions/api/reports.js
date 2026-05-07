import { getRedis, withRedisRetry } from '../lib/redis.js';
import {
  analyzeReport,
  sanitizeReportInput,
  hashKey,
  rebuildDisplay,
  diffExcluded,
} from '../lib/re-eye-report.js';
import { detectAnomaly } from '../lib/re-eye-health.js';
import { updateCircuit } from '../lib/re-eye-circuit.js';

const KEY_ALL = 'reeye:reports:all';
const MAX_KEEP = 500;
const HEALTH_LIST = 'reeye:health:events';
const HEALTH_KEEP = 1000;
// rolling 集計は system-health 側に集約（reports は event保存 + circuit更新のみ）

function setNoStore(res) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  setNoStore(res);

  const raw = req.body || {};
  if (!Array.isArray(raw.apiItems)) {
    return res.status(400).json({ error: 'apiItems must be an array' });
  }
  if (!Array.isArray(raw.displayItemIds)) {
    return res.status(400).json({ error: 'displayItemIds must be an array' });
  }

  const input = sanitizeReportInput(raw);
  if (!input.query) return res.status(400).json({ error: 'query is required' });

  const displayItemsRebuilt = rebuildDisplay(input.apiItems, input.displayItemIds);
  const excludedItems = diffExcluded(input.apiItems, displayItemsRebuilt);
  const analysis = analyzeReport(input);
  const anomaly = detectAnomaly({ ...input, excludedItems, analysis });

  /** 保存・応答とも「最終形」＋サーバー算出メタのみ */
  const final = {
    query: input.query,
    userProfile: input.userProfile,
    targetSize: input.targetSize,
    color: input.color,
    apiItems: input.apiItems,
    displayItemIds: input.displayItemIds,
    snapshotVersion: input.snapshotVersion,
    sourceApi: input.sourceApi,
    userId: input.userId,
    excludedItems,
    analysis,
    anomaly,
    receivedAt: Date.now(),
    version: 're_eye_report_v2_clean',
  };

  try {
    const r = getRedis();
    const json = JSON.stringify(final);
    await withRedisRetry(() => r.lpush(KEY_ALL, json), { label: 'reports-lpush' });
    await withRedisRetry(() => r.ltrim(KEY_ALL, 0, MAX_KEEP - 1), { label: 'reports-ltrim' });

    const qKey = `reeye:reports:q:${hashKey(input.query)}`;
    await withRedisRetry(() => r.lpush(qKey, json), { label: 'reports-q-lpush' });
    await withRedisRetry(() => r.ltrim(qKey, 0, 100 - 1), { label: 'reports-q-ltrim' });
    await withRedisRetry(() => r.expire(qKey, 60 * 60 * 24 * 30), { label: 'reports-q-expire' });

    // healthメタは本体とは別に保存（運用OSレイヤー）
    const healthEvent = {
      score: anomaly.score,
      level: anomaly.level,
      query: input.query,
      ts: Date.now(),
      api: input.sourceApi || 'unknown',
    };
    await withRedisRetry(() => r.lpush(HEALTH_LIST, JSON.stringify(healthEvent)), { label: 'health-lpush' });
    await withRedisRetry(() => r.ltrim(HEALTH_LIST, 0, HEALTH_KEEP - 1), { label: 'health-ltrim' });
    // circuit 更新（report単位。in-memory禁止）
    try {
      await updateCircuit(r, anomaly.score);
    } catch {
      /* ignore */
    }
  } catch (e) {
    console.error('[reports] save failed:', e && e.message);
  }

  return res.status(200).json(final);
}
