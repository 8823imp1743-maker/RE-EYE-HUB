import { withRedisRetry } from './redis.js';
import { opsJsonLog } from './notify-ops-log.js';

const BUCKET_MS = 60 * 1000;

/**
 * グローバル「通知試行」を 1 分粒度で INCR（notify_per_min 観測用）
 */
export async function incrNotifyAttemptsPerMinute(r) {
  const b = Math.floor(Date.now() / BUCKET_MS);
  const key = `metric:nfy:atm:v1:${b}`;
  try {
    const n = await withRedisRetry(() => r.incr(key), {
      label: 'metric-notify-per-min-incr',
    });
    if (n === 1) {
      await withRedisRetry(() => r.expire(key, 600), {
        label: 'metric-notify-per-min-expire',
      });
    }
    if (typeof n === 'number' && (n === 1 || n % 100 === 0)) {
      opsJsonLog('notify_per_min', {
        minuteBucket: b,
        attemptsThisMinute: n,
      });
    }
    return n;
  } catch {
    return null;
  }
}
