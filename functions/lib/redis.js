/**
 * Upstash Redis クライアント
 */

import { Redis } from '@upstash/redis';

let redis = null;

export function getRedis() {
  if (!redis) {
    const url   = (process.env.UPSTASH_REDIS_REST_URL   || '').trim();
    const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
    if (!url || !token) {
      throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set');
    }
    redis = new Redis({ url, token });
  }
  return redis;
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
