/**
 * Upstash Redis クライアント
 */

import { Redis } from '@upstash/redis';

let redis = null;

export function getRedis() {
  if (!redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set');
    }
    redis = new Redis({ url, token });
  }
  return redis;
}

export async function markSeen(key) {
  const r = getRedis();
  await r.set(key, '1', { ex: 60 * 60 * 24 * 365 }); // 1年保存
}

export async function isSeen(key) {
  const r = getRedis();
  const val = await r.get(key);
  return val !== null;
}
