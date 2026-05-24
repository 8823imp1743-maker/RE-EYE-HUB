/**
 * GET /api/usage-status
 * 外部API 無料枠の使用量 + 残量予測を返す。
 */
import { quotaStatus, buildRedisStatus, getWindowElapsedHours } from '../lib/quota-manager.js';
import { redisGuardStatus } from '../lib/redis-guard.js';

function setNoStore(res) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  setNoStore(res);

  const qs      = quotaStatus();
  const rg      = redisGuardStatus();
  const elapsed = getWindowElapsedHours();

  const allServices = {
    ...qs,
    redis: buildRedisStatus(rg, elapsed),
  };

  // ── サマリー計算 ─────────────────────────────────────────
  const entries = Object.entries(allServices);

  // 最も残り時間が短いサービス（null = ∞ は除外）
  const finiteEntries = entries.filter(
    ([, v]) => v.remainingHours !== null && v.ok
  );
  let worstCase = null;
  let worstHours = Infinity;
  for (const [k, v] of finiteEntries) {
    if (v.remainingHours < worstHours) {
      worstHours = v.remainingHours;
      worstCase  = k;
    }
  }

  const hasCritical = entries.some(([, v]) => v.status === 'CRITICAL');
  const hasWarning  = entries.some(([, v]) => v.status === 'WARNING');
  const systemStatus =
    hasCritical ? 'CRITICAL' :
    hasWarning  ? 'WARNING'  :
    'SAFE';

  return res.status(200).json({
    ...allServices,
    summary: {
      systemStatus,
      worstCase,
      worstRemainingHours: worstCase ? worstHours : null,
      elapsedHours: Math.round(elapsed * 10) / 10,
    },
  });
}
