/**
 * 楽天・Yahoo 横断 searchAll の結果を Redis に短時間キャッシュし、
 * 同一キーワード・同一オプションの重複 API 呼び出しを抑える。
 *
 * Redis 未設定・Upstash 通信失敗時も searchAll は必ず試行し、例外を外に投げない。
 */

import { createHash } from 'crypto';
import { getRedis } from './redis.js';
import { searchAll } from './shop-adapters/index.js';
import { guardRedisWrite } from './redis-guard.js';

const DEFAULT_TTL_SEC = 180;

function isRunCli() {
  return process.env.RE_EYE_CLI === '1' || process.env.RE_EYE_CLI === 'true';
}

function buildKey(keyword, options) {
  const preserve = Array.isArray(options.mallPreserveTokens)
    ? options.mallPreserveTokens.map((t) => String(t || '').trim()).filter(Boolean).sort()
    : [];
  const o = {
    maxResults: options.maxResults ?? 20,
    inStockOnly: !!options.inStockOnly,
    mallPreserveTokens: preserve,
    page: options.page > 0 ? options.page : 1,
    yahooStart: options.yahooStart > 0 ? options.yahooStart : 1,
  };
  const h = createHash('sha256')
    .update(`${keyword}\0${JSON.stringify(o)}`)
    .digest('hex')
    .slice(0, 40);
  return `shopsearch:v3:${h}`;
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

  if (skipCache) {
    console.log(
      '[AUDIT][shop-cache] skipCache=true → Redis 読取/書込をスキップ | keyHead=' + key.slice(0, 32) + '… | keyword=' +
        String(keyword).slice(0, 200)
    );
  }

  let r = null;
  try {
    r = getRedis();
  } catch (e) {
    console.warn('[shop-cache] Redis 未設定、キャッシュなし:', e.message);
  }

  if (r && !skipCache) {
    try {
      const raw = await r.get(key);
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
          console.log(`[shop-cache] HIT ${key.slice(0, 24)}…`);
          if (isRunCli()) {
            const k = String(keyword || '').slice(0, 72);
            console.log(`[run-cli] ショップ検索キャッシュヒット（楽天・Yahoo API は呼び出しません）「${k}${k.length >= 72 ? '…' : ''}」`);
          }
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[shop-cache] read:', e.message);
    }
  }

  if (isRunCli()) {
    const k = String(keyword || '').slice(0, 72);
    console.log(
      `[run-cli] ショップ検索キャッシュミス — 楽天・Yahoo の API を呼び出します「${k}${k.length >= 72 ? '…' : ''}」`
    );
  } else if (skipCache) {
    const k = String(keyword || '').slice(0, 100);
    console.log(
      '[AUDIT][shop-cache] searchAll 直前 キーワード="' + k + (k.length >= 100 ? '…' : '') + '"'
    );
  }

  let result;
  try {
    result = await searchAll(keyword, searchOpts);
  } catch (e) {
    console.error('[shop-cache] searchAll 例外:', e.message);
    result = { items: [], errors: [e.message || 'search failed'] };
  }

  if (!result || typeof result !== 'object') {
    result = { items: [], errors: ['invalid search result'] };
  }
  if (!Array.isArray(result.items)) result.items = [];
  if (!Array.isArray(result.errors)) result.errors = [];
  if (skipCache) {
    console.log(
      '[AUDIT][shop-cache] searchAll 戻り items=' + result.items.length + ' errors=' + (result.errors || []).length
    );
  }

  if (r && !skipCache && guardRedisWrite('shop-cache-write')) {
    try {
      await r.set(key, JSON.stringify(result), { ex: ttl });
    } catch (e) {
      console.warn('[shop-cache] write:', e.message);
    }
  }
  return result;
}
