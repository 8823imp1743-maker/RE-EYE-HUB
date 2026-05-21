/**
 * サイズ検知ログ（軽量・任意）
 * env RE_EYE_PDP_LOG=1 のときのみ 1キー PUT（TTL短め）
 */

import { createHash } from 'crypto';
import { getRedis } from './redis.js';
import { withRedisRetry } from './redis.js';

function tryGetRedis() {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

/**
 * PDP 結果のサンプルをログ（将来の調整／集計用。既定オフ）
 * @param {{ canonicalUrl: string, rawCm: string, result: Record<string, unknown> }} opts
 */
export async function optionallyLogPdpDecision(opts) {
  if (process.env.RE_EYE_PDP_LOG !== '1' && process.env.RE_EYE_PDP_LOG !== 'true') return;
  const r = tryGetRedis();
  if (!r || !opts) return;

  const { canonicalUrl, rawCm, result } = opts;
  const uh = createHash('sha256').update(String(canonicalUrl || '')).digest('hex').slice(0, 16);
  const cms = String(rawCm ?? '').trim().slice(0, 12);
  const key = `log:size:${uh}:${cms}`;

  const payload = {
    ts: Date.now(),
    ok: result && result.ok,
    reason: result && result.reason,
    tentative: result && result.pdpTentative,
  };

  try {
    await withRedisRetry(() => r.set(key, JSON.stringify(payload), { ex: 86400 }), {
      label: 'pdp-learn-log-set',
    });
  } catch {
    // graceful
  }
}
