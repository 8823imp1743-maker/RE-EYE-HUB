/**
 * Upstash Redis クライアント
 *
 * Vercel 上で global fetch（undici）が Upstash REST へ繋がらず "fetch failed" になることがあるため、
 * node:https + IPv4 固定のカスタム Requester を使う（functions/lib/upstash-node-https-client.js）。
 * 短いリトライは withRedisRetry を利用。
 */

import { Redis } from '@upstash/redis';
import { createUpstashNodeHttpsClient } from './upstash-node-https-client.js';

let redis = null;

function resolveUpstashRestCredentials() {
  const url = (
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    ''
  ).trim();
  const token = (
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    ''
  ).trim();
  return { url, token };
}

export function getRedis() {
  if (!redis) {
    const { url, token } = resolveUpstashRestCredentials();
    if (!url || !token) {
      throw new Error(
        'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN)'
      );
    }
    redis = new Redis(createUpstashNodeHttpsClient(url, token));
  }
  return redis;
}

/**
 * Upstash の HTTP レイヤーが落ちる・タイムアウトする場合に数回だけ再試行する。
 * @param {() => Promise<any>} fn
 * @param {{ label?: string, retries?: number }} [opts]
 */
export async function withRedisRetry(fn, opts = {}) {
  const { label = 'redis', retries = 3 } = opts;
  let last;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String(e?.message || e);
      // quota 超過・認証エラーはリトライしない（余計な消費を防ぐ）
      const nonRetryable =
        /max daily|quota|rate limit|429|401|403|unauthorized|forbidden/i.test(msg);
      if (nonRetryable) break;
      const retryable =
        /fetch failed|Failed to fetch|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|socket|network|502|503|504/i.test(
          msg
        );
      if (!retryable || attempt === retries) break;
      const ms = 120 * attempt;
      console.warn(`[redis] ${label} retry ${attempt}/${retries} (${ms}ms): ${msg.slice(0, 100)}`);
      await new Promise(r => setTimeout(r, ms));
    }
  }
  throw last;
}

export async function markSeen(key) {
  const r = getRedis();
  await r.set(key, '1', { ex: 60 * 60 * 24 * 60 }); // 60日保存（CLAUDE.md Deep Recon 仕様に準拠）
}

export async function isSeen(key) {
  const r = getRedis();
  const val = await r.get(key);
  return val !== null;
}
