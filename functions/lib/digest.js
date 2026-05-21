import { withRedisRetry } from './redis.js';
import { opsJsonLog } from './notify-ops-log.js';

const DIGEST_BUCKET_MIN = 5;
const DIGEST_TTL_SEC = 600; // 10分
const DIGEST_MAX_ITEMS = 20;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Functions の実行環境は UTC のことが多いため、JST 固定で bucket を作る。
 * @param {number} ts
 */
export function jstBucketStamp(ts, bucketMin = DIGEST_BUCKET_MIN) {
  const t = new Date(ts + 9 * 60 * 60 * 1000); // JST に寄せる
  const y = t.getUTCFullYear();
  const mo = pad2(t.getUTCMonth() + 1);
  const d = pad2(t.getUTCDate());
  const hh = pad2(t.getUTCHours());
  const mm0 = t.getUTCMinutes();
  const mm = pad2(Math.floor(mm0 / bucketMin) * bucketMin);
  return `${y}${mo}${d}_${hh}${mm}`;
}

export function digestKey(target, stamp) {
  return `digest:${String(target)}:${String(stamp)}`;
}

function lastStampKey(target) {
  return `digest:last:${String(target)}`;
}

function lockKey(target, stamp) {
  return `digest:lock:${String(target)}:${String(stamp)}`;
}

/**
 * @param {any} item
 */
function safeJson(item) {
  try {
    return JSON.stringify(item);
  } catch {
    return JSON.stringify({ kind: 'digest_item', fallback: String(item) });
  }
}

/**
 * Digest に積む。bucket が変わったら「前bucket」を自己回収で flush する。
 *
 * @param {*} r Redis
 * @param {{
 *  target: string,
 *  nowTs?: number,
 *  item: any,
 *  onFlush: (payload: { target: string, stamp: string, items: any[] }) => Promise<void>,
 * }} opts
 */
export async function enqueueDigestItem(r, opts) {
  const target = String(opts.target || '').trim();
  if (!target) return { ok: false, reason: 'no_target' };
  const nowTs = Number.isFinite(opts.nowTs) ? opts.nowTs : Date.now();
  const stamp = jstBucketStamp(nowTs, DIGEST_BUCKET_MIN);
  const key = digestKey(target, stamp);

  // 前バケットがあれば flush（自己回収）
  let prev = null;
  try {
    prev = await withRedisRetry(() => r.get(lastStampKey(target)), { label: 'digest:last:get' });
  } catch {
    prev = null;
  }
  if (prev && typeof prev === 'string' && prev !== stamp) {
    await flushDigestBucket(r, {
      target,
      stamp: prev,
      onFlush: opts.onFlush,
      reason: 'bucket_rollover',
    });
  }

  // 積む + トリム + TTL
  await withRedisRetry(() => r.rpush(key, safeJson(opts.item)), { label: 'digest:rpush' });
  await withRedisRetry(() => r.ltrim(key, 0, DIGEST_MAX_ITEMS - 1), { label: 'digest:ltrim' });
  try {
    const len = await withRedisRetry(() => r.llen(key), { label: 'digest:llen-post' });
    if (Number(len) >= DIGEST_MAX_ITEMS) {
      opsJsonLog('digest_overflow', { key, len: DIGEST_MAX_ITEMS });
    }
  } catch {
    /* ok */
  }
  await withRedisRetry(() => r.expire(key, DIGEST_TTL_SEC), { label: 'digest:expire' });
  await withRedisRetry(() => r.set(lastStampKey(target), stamp, { ex: DIGEST_TTL_SEC }), { label: 'digest:last:set' });

  // 上限に達したら即 flush（通知回数は増えるが、積み残し防止）
  try {
    const len = await withRedisRetry(() => r.llen(key), { label: 'digest:llen' });
    if (Number(len) >= DIGEST_MAX_ITEMS) {
      await flushDigestBucket(r, { target, stamp, onFlush: opts.onFlush, reason: 'max_items' });
    }
  } catch {/* ignore */}

  return { ok: true, stamp, key };
}

/**
 * Digest bucket を flush（同一 bucket は lock で多重送信を避ける）
 *
 * @param {*} r Redis
 * @param {{
 *  target: string,
 *  stamp: string,
 *  onFlush: (payload: { target: string, stamp: string, items: any[] }) => Promise<void>,
 *  reason?: string,
 * }} opts
 */
export async function flushDigestBucket(r, opts) {
  const target = String(opts.target || '').trim();
  const stamp = String(opts.stamp || '').trim();
  if (!target || !stamp) return { ok: false, reason: 'bad_args' };
  const key = digestKey(target, stamp);

  // lock（多重 flush 回避）
  try {
    const got = await withRedisRetry(
      () => r.set(lockKey(target, stamp), '1', { ex: 30, nx: true }),
      { label: 'digest:lock' },
    );
    if (got == null) return { ok: true, skipped: true, reason: 'locked' };
  } catch {/* fail-open */}

  let raw = [];
  try {
    raw = await withRedisRetry(() => r.lrange(key, 0, -1), { label: 'digest:lrange' });
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    // 空なら片付けだけ
    try { await withRedisRetry(() => r.del(key), { label: 'digest:del-empty' }); } catch {}
    return { ok: true, sent: 0, reason: 'empty' };
  }

  const items = raw.map((s) => {
    try { return JSON.parse(String(s)); } catch { return { kind: 'digest_item', raw: String(s) }; }
  });

  try {
    await opts.onFlush({ target, stamp, items });
  } catch (e) {
    console.error('[digest] flush send failed:', e?.message || String(e));
    return { ok: false, reason: 'send_fail' };
  }

  // 成功したら削除
  try { await withRedisRetry(() => r.del(key), { label: 'digest:del' }); } catch {}
  return { ok: true, sent: items.length, reason: opts.reason || 'flush' };
}

