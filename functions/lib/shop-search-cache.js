/**
 * 楽天・Yahoo 横断 searchAll の結果を Redis に短時間キャッシュし、
 * 同一キーワード・同一オプションの重複 API 呼び出しを抑える。
 */

import { createHash } from 'crypto';
import { getRedis } from './redis.js';
import { searchAll } from './shop-adapters/index.js';

const DEFAULT_TTL_SEC = 180;

function buildKey(keyword, options) {
  const o = {
    maxResults: options.maxResults ?? 20,
    inStockOnly: !!options.inStockOnly,
  };
  const h = createHash('sha256')
    .update(`${keyword}\0${JSON.stringify(o)}`)
    .digest('hex')
    .slice(0, 40);
  return `shopsearch:v2:${h}`;
}

/**
 * @param {string} keyword
 * @param {object} [options] searchAll に渡すオプション + cacheTtlSec / skipCache
 */
export async function searchAllCached(keyword, options = {}) {
  const ttl =
    Number(options.cacheTtlSec) > 0 ? Number(options.cacheTtlSec) : DEFAULT_TTL_SEC;
  const skipCache = options.skipCache === true;
  const { cacheTtlSec, skipCache: _s, ...searchOpts } = options;

  const key = buildKey(keyword, searchOpts);
  const r = getRedis();

  if (!skipCache) {
    try {
      const raw = await r.get(key);
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        console.log(`[shop-cache] HIT ${key.slice(0, 24)}…`);
        return parsed;
      }
    } catch (e) {
      console.warn('[shop-cache] read:', e.message);
    }
  }

  const result = await searchAll(keyword, searchOpts);
  try {
    await r.set(key, JSON.stringify(result), { ex: ttl });
  } catch (e) {
    console.warn('[shop-cache] write:', e.message);
  }
  return result;
}
