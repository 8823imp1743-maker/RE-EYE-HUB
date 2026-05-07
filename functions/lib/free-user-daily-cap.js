import { withRedisRetry } from './redis.js';
import { isPaidPlan } from './notify-plan-policy.js';

function dayStampUtc() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${mo}${da}`;
}

function dailyKey(uid) {
  return `nfc:notify:day:v2:${uid}:${dayStampUtc()}`;
}

/** env: RE_EYE_FREE_NOTIFY_DAILY_MAX（未設定または0=無制限） */
export function getConfiguredFreeDailyMax() {
  const raw = Number(process.env.RE_EYE_FREE_NOTIFY_DAILY_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : 0;
}

function dailyCapNum() {
  return getConfiguredFreeDailyMax();
}

/**
 * 当日カウント（送信成功カウントと整合。読みのみ）
 */
export async function readFreeDailyNotifyUsage(r, userId) {
  const cap = dailyCapNum();
  const id = String(userId || '').trim();
  if (!id) return { cur: 0, cap, atLimit: false };
  try {
    const cur = Number(await withRedisRetry(() => r.get(dailyKey(id)), { label: 'free-dcap-read' })) || 0;
    return {
      cur,
      cap,
      atLimit: !!(cap && cur >= cap),
    };
  } catch {
    return { cur: 0, cap, atLimit: false };
  }
}

/**
 * 送信試行前チェック（成功送信は postRecord で加算）
 */
export async function freeDailyCapPreSend(r, userId, plan) {
  if (isPaidPlan(plan)) return { ok: true, cap: dailyCapNum() };
  const cap = dailyCapNum();
  if (!cap) return { ok: true, cap };
  const id = String(userId || '').trim();
  if (!id) return { ok: false, cap };
  try {
    const cur = Number(await withRedisRetry(() => r.get(dailyKey(id)), { label: 'free-dcap-get' })) || 0;
    if (cur >= cap) return { ok: false, cap, cur };
    return { ok: true, cap, cur };
  } catch {
    return { ok: true, cap };
  }
}

/**
 * OneSignal が 200 で返ってきた直後のみ呼ぶ
 */
export async function freeDailyCapRecordSuccess(r, userId, plan) {
  if (isPaidPlan(plan)) return null;
  const cap = dailyCapNum();
  if (!cap) return null;
  const id = String(userId || '').trim();
  if (!id) return null;
  try {
    const n = await withRedisRetry(() => r.incr(dailyKey(id)), { label: 'free-dcap-incr' });
    if (n === 1) {
      await withRedisRetry(() => r.expire(dailyKey(id), 86400 * 4), { label: 'free-dcap-exp' });
    }
    return n;
  } catch {
    return null;
  }
}
