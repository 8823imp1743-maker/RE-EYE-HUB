import { withRedisRetry } from './redis.js';

const DEFAULT_MAX = 20;

/**
 * userId 単位・任意窓のプッシュ送信回数（INCR + EXPIRE）
 * - 秒窓: windowSec
 * - bucket は windowSec ごとに切る
 * @param {*} r — Upstash Redis REST クライアント
 * @param {string} userId
 * @param {{ windowSec: number, max: number, keyPrefix: string, label?: string, expireSec?: number }} opts
 */
export async function allowUserPushPerWindow(r, userId, opts) {
  const id = typeof userId === 'string' ? userId.trim() : '';
  if (!id) return false;
  const windowSec = Number(opts?.windowSec);
  const max = Number(opts?.max);
  const keyPrefix = String(opts?.keyPrefix || '').trim();
  if (!Number.isFinite(windowSec) || windowSec <= 0) return false;
  if (!Number.isFinite(max) || max <= 0) return false;
  if (!keyPrefix) return false;
  const cap = Math.min(Math.floor(max), 1000000);
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const key = `${keyPrefix}:${id}:${bucket}`;
  const expireSec = Number(opts?.expireSec);
  const ttl = Number.isFinite(expireSec) && expireSec > 0 ? Math.floor(expireSec) : windowSec * 2;
  const label = opts.label || keyPrefix;
  try {
    const n = await withRedisRetry(() => r.incr(key), { label: `${label}-incr` });
    if (n === 1) {
      await withRedisRetry(() => r.expire(key, ttl), { label: `${label}-expire` });
    }
    return n <= cap;
  } catch (e) {
    console.warn(`[${label}] burst (fail-open):`, e.message);
    return true;
  }
}

/**
 * userId 単位・1分窓ごとのプッシュ送信回数（INCR + EXPIRE）
 * @param {*} r — Upstash Redis REST クライアント
 * @param {string} userId
 * @param {{ maxPerMinute?: number, label?: string }} [opts]
 */
export async function allowUserPushPerMinute(r, userId, opts = {}) {
  const raw = Number(opts.maxPerMinute);
  const cap =
    Number.isFinite(raw) && raw > 0
      ? Math.min(raw, 120)
      : Number(process.env.MONITOR_PUSH_MAX_PER_USER_PER_MIN) || DEFAULT_MAX;
  return allowUserPushPerWindow(r, userId, {
    windowSec: 60,
    max: cap,
    keyPrefix: 'push:u1m',
    label: opts.label || 'push-u1m',
    expireSec: 120,
  });
}

/**
 * userId 単位・5分窓ごとの上限（env: MONITOR_PUSH_MAX_PER_USER_PER_5MIN / デフォルト 80）
 */
export async function allowUserPushPer5Min(r, userId, opts = {}) {
  const raw = Number(opts.maxPer5Min);
  const env = Number(process.env.MONITOR_PUSH_MAX_PER_USER_PER_5MIN);
  const cap =
    Number.isFinite(raw) && raw > 0
      ? Math.min(raw, 2000)
      : (Number.isFinite(env) && env > 0 ? Math.min(env, 2000) : 80);
  return allowUserPushPerWindow(r, userId, {
    windowSec: 300,
    max: cap,
    keyPrefix: 'push:u5m',
    label: opts.label || 'push-u5m',
    expireSec: 900,
  });
}

/**
 * userId 単位・1日窓ごとの上限（env: MONITOR_PUSH_MAX_PER_USER_PER_DAY / デフォルト 500）
 */
export async function allowUserPushPerDay(r, userId, opts = {}) {
  const raw = Number(opts.maxPerDay);
  const env = Number(process.env.MONITOR_PUSH_MAX_PER_USER_PER_DAY);
  const cap =
    Number.isFinite(raw) && raw > 0
      ? Math.min(raw, 200000)
      : (Number.isFinite(env) && env > 0 ? Math.min(env, 200000) : 500);
  return allowUserPushPerWindow(r, userId, {
    windowSec: 86400,
    max: cap,
    keyPrefix: 'push:u1d',
    label: opts.label || 'push-u1d',
    expireSec: 172800,
  });
}
