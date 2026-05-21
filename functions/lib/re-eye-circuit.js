const KEY = 'reeye:circuit:state';

/**
 * Circuit Breaker（完全Redis固定）
 * @param {import('./redis.js').RedisClient} redis
 * @param {number} score
 */
export async function updateCircuit(redis, score) {
  const s = Number(score) || 0;
  let state = 'healthy';
  if (s > 100) state = 'open';
  else if (s > 60) state = 'degraded';
  await redis.set(KEY, state);
  return state;
}

/**
 * @param {import('./redis.js').RedisClient} redis
 */
export async function getCircuit(redis) {
  const v = await redis.get(KEY);
  const t = String(v || '').trim();
  return t || 'healthy';
}

