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

/** Vercel / Upstash 連携で scheme 欠落・redis:// 形式になる場合の正規化 */
function normalizeRedisRestUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if ((u.startsWith('"') && u.endsWith('"')) || (u.startsWith("'") && u.endsWith("'"))) {
    u = u.slice(1, -1).trim();
  }
  if (/^redis(s)?:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      if (parsed.hostname) return `https://${parsed.hostname}`.replace(/\/$/, '');
    } catch {
      /* fall through */
    }
  }
  if (!/^https?:\/\//i.test(u)) {
    if (/^[a-z0-9][a-z0-9.-]*\.upstash\.io/i.test(u)) {
      u = `https://${u}`;
    }
  }
  return u.replace(/\/$/, '');
}

function isPlausibleRedisRestUrl(url) {
  return url && /^https:\/\/[a-z0-9][a-z0-9.-]*(?::\d+)?(?:\/|$)/i.test(url);
}

function pickRedisRestUrl() {
  const candidates = [
    process.env.UPSTASH_REDIS_REST_URL,
    process.env.KV_REST_API_URL,
  ];
  for (const raw of candidates) {
    const url = normalizeRedisRestUrl(raw);
    if (isPlausibleRedisRestUrl(url)) return url;
  }
  return '';
}

function pickRedisRestToken() {
  const candidates = [
    process.env.UPSTASH_REDIS_REST_TOKEN,
    process.env.KV_REST_API_TOKEN,
  ];
  for (const raw of candidates) {
    const t = String(raw || '').trim().replace(/^["']|["']$/g, '');
    if (!t) continue;
    if (isPlausibleRedisRestUrl(normalizeRedisRestUrl(t))) continue;
    if (/^redis(s)?:\/\//i.test(t)) continue;
    return t;
  }
  return '';
}

function resolveUpstashRestCredentials() {
  const url = pickRedisRestUrl();
  const token = pickRedisRestToken();
  return { url, token };
}

/** 診断用: URL ホストのみ（秘密は返さない） */
export function redisRestHostForDiagnostics() {
  const url = pickRedisRestUrl();
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 32);
  }
}

/**
 * 診断用: 1 回の r.get（withRedisRetry なし）の所要 ms と成否を返す。
 * system-health?redisProbe=1 から呼ぶ。
 */
export async function probeRedisGet(key = 're-eye:redis-probe') {
  const t0 = Date.now();
  const urlHost = redisRestHostForDiagnostics();
  try {
    const r = getRedis();
    const val = await r.get(key);
    const ms = Date.now() - t0;
    console.log(`[redis-probe] GET ok key=${key} ms=${ms} host=${urlHost} hasValue=${val != null}`);
    return { ok: true, ms, urlHost, hasValue: val != null };
  } catch (e) {
    const ms = Date.now() - t0;
    const err = String(e?.message || e).slice(0, 240);
    console.log(`[redis-probe] GET fail key=${key} ms=${ms} host=${urlHost} err=${err}`);
    return { ok: false, ms, urlHost, error: err };
  }
}

export function getRedis() {
  if (!redis) {
    const { url, token } = resolveUpstashRestCredentials();
    if (!url || !token) {
      throw new Error(
        'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN)'
      );
    }
    if (!isPlausibleRedisRestUrl(url)) {
      throw new Error(
        `Invalid UPSTASH_REDIS_REST_URL (expected https://...upstash.io, got "${url.slice(0, 48)}")`
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
