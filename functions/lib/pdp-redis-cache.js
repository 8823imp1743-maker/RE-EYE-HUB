/**
 * PDP 結果の Redis キャッシュ（インスタンス間共有・コスト削減）
 * キー: pdp:cache:{urlHash}:{cmSlug}  dom_structural 成功のみ TTL（既定 120s）
 */

import { createHash } from 'crypto';
import { getRedis } from './redis.js';
import { withRedisRetry } from './redis.js';

export const PDP_CACHE_TTL_SEC = 120;

function tryGetRedis() {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

/**
 * @param {string} canonicalUrl normalizeRakutenUrl 済み推奨
 * @param {string} rawCm
 */
export function pdpRedisKey(canonicalUrl, rawCm) {
  const hash = createHash('sha256').update(String(canonicalUrl || '')).digest('hex');
  const cmSafe = String(rawCm ?? '').trim().replace(/\s+/g, '').slice(0, 16).replace(/[^0-9.]/g, '_');
  return `pdp:cache:${hash}:${cmSafe || '_'}`;
}

/**
 * @typedef {{ ok: boolean | null, reason?: string, method?: string, pdpTentative?: boolean, retryable?: boolean, ms?: number, ts?: number }} PdpRedisRecord
 */

/**
 * @param {string} canonicalUrl
 * @param {string} rawCm
 * @returns {Promise<PdpRedisRecord | null>}
 */
export async function redisGetPdpCache(canonicalUrl, rawCm) {
  const r = tryGetRedis();
  if (!r) return null;
  const key = pdpRedisKey(canonicalUrl, rawCm);
  try {
    const raw = await withRedisRetry(() => r.get(key), { label: 'pdp-cache-get' });
    if (raw == null || raw === '') return null;
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    return /** @type {PdpRedisRecord} */ (obj);
  } catch {
    return null;
  }
}

/**
 * @param {string} canonicalUrl
 * @param {string} rawCm
 * @param {PdpRedisRecord} payload
 * @param {number} [ttlSec] 省略時は PDP_CACHE_TTL_SEC（dom_structural 短期）。fetch_fail は 15s 等。
 */
export async function redisSetPdpCache(canonicalUrl, rawCm, payload, ttlSec = PDP_CACHE_TTL_SEC) {
  const r = tryGetRedis();
  if (!r) return;
  const key = pdpRedisKey(canonicalUrl, rawCm);
  const ts = typeof payload.ts === 'number' ? payload.ts : Date.now();
  const ex = Math.max(1, Math.min(86400, Math.floor(Number(ttlSec)) || PDP_CACHE_TTL_SEC));
  try {
    await withRedisRetry(
      () =>
        r.set(
          key,
          JSON.stringify({ ...payload, ts }),
          { ex }
        ),
      { label: 'pdp-cache-set' }
    );
  } catch {
    // graceful
  }
}

/**
 * Redis 復元オブジェクトを verify 結果形へ
 * @param {PdpRedisRecord} rec
 */
export function hydratePdpResultFromRedis(rec) {
  return {
    ok: rec.ok,
    reason: rec.reason ?? 'redis_cache',
    method: rec.method ?? 'redis_pdp_cache',
    pdpTentative: !!rec.pdpTentative,
    retryable: !!rec.retryable,
    ms: typeof rec.ms === 'number' ? rec.ms : 0,
  };
}
