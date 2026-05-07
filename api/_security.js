/**
 * Vercel serverless: 厳格 CORS + Upstash レート制限
 * 機密（APIキー等）は常に process.env / Functions 側のみ。本ファイルにハードコードしない。
 */

import { withRedisRetry, getRedis } from '../functions/lib/redis.js';

const RL_WINDOW_SEC = 60;
const TIER = {
  search: { key: 'rl:search', max: () => intEnv('RE_EYE_RL_SEARCH_MAX', 24) },
  heavy: { key: 'rl:heavy', max: () => intEnv('RE_EYE_RL_HEAVY_MAX', 40) },
  default: { key: 'rl:api', max: () => intEnv('RE_EYE_RL_DEFAULT_MAX', 120) },
};

function intEnv(name, d) {
  const v = parseInt((process.env[name] || String(d)).trim(), 10);
  return Number.isFinite(v) && v > 0 ? v : d;
}

function defaultAllowedOrigins() {
  return [
    'https://re-eye-hub.vercel.app',
    'https://re-eye-hub.web.app',
    'https://re-eye-hub.firebaseapp.com',
  ];
}

export function getAllowedOrigins() {
  const base = defaultAllowedOrigins();
  const extra = (process.env.RE_EYE_ALLOWED_ORIGINS || '').trim();
  if (!extra) return base;
  const merged = [...base];
  const seen = new Set(base);
  for (const s of extra.split(',')) {
    const o = String(s || '').trim();
    if (o && !seen.has(o)) {
      merged.push(o);
      seen.add(o);
    }
  }
  return merged;
}

/**
 * ブラウザの Origin または Referer からオリジンを推定
 */
function getRequestOriginClient(req) {
  const o = (req.headers.origin || req.headers.Origin || '').toString();
  if (o) return o;
  const ref = (req.headers.referer || req.headers.referrer || '').toString();
  try {
    if (ref) return new URL(ref).origin;
  } catch (e) {
    /* */
  }
  return '';
}

function isAllowedClientOrigin(origin) {
  if (!origin) return false;
  const list = getAllowedOrigins();
  if (list.includes(origin)) return true;
  if (process.env.RE_EYE_ALLOW_VERCEL_PREV === '1' && /https:\/\/re-eye-[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
    return true;
  }
  return false;
}

/**
 * 同一 NAT 下の区別: x-forwarded-for 先頭
 */
export function getClientIpForRateLimit(req) {
  const xf = (req.headers['x-forwarded-for'] || '').toString();
  if (xf) {
    const first = xf.split(',')[0].trim();
    if (first) return first.slice(0, 128);
  }
  const rip = (req.headers['x-real-ip'] || '').toString();
  if (rip) return rip.slice(0, 128);
  if (req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress).slice(0, 128);
  return 'unknown';
}

function setCorsHeadersForOrigin(res, allowOrigin) {
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function applyRelaxCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * レート制限: Redis 必須。未設定/障害時は失敗 open（利用継続を優先）してログのみ。
 * @param {'search'|'heavy'|'default'} tier
 */
export async function rateLimitOrPass(req, res, tier) {
  if (process.env.RE_EYE_DISABLE_RATE_LIMIT === '1') return true;
  const t = TIER[tier] || TIER.default;
  const max = t.max();
  const ip = getClientIpForRateLimit(req);
  const key = `${t.key}:${ip}`;
  try {
    const r = getRedis();
    const n = await withRedisRetry(() => r.incr(key), { label: 'rl-incr' });
    if (n === 1) {
      await withRedisRetry(() => r.expire(key, RL_WINDOW_SEC), { label: 'rl-exp' });
    }
    if (n > max) {
      if (typeof res.status === 'function') {
        res.setHeader('Retry-After', String(RL_WINDOW_SEC));
        res.status(429).json({
          error: 'too_many_requests',
          message: '短時間のリクエストが多すぎます。しばらく待ってから再試行してください。',
        });
        return false;
      }
      res.statusCode = 429;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Retry-After', String(RL_WINDOW_SEC));
      res.end(
        JSON.stringify({
          error: 'too_many_requests',
          message: '短時間のリクエストが多すぎます。しばらく待ってから再試行してください。',
        })
      );
      return false;
    }
  } catch (e) {
    console.error('[api/_security] rate-limit fail-open:', e && e.message);
  }
  return true;
}

/**
 * CORS 検証 + OPTIONS 応答。レート制限（POST/GET 本体前）。
 * @returns {Promise<'ok'|'blocked'>}
 */
export async function guardVercelApi(req, res, opts) {
  const o = opts || {};
  const rateTier = o.rateTier === 'none' ? 'none' : o.rateTier || 'default';
  if (process.env.RE_EYE_RELAX_CORS === '1') {
    applyRelaxCors(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return 'blocked';
    }
    if (rateTier !== 'none' && !(await rateLimitOrPass(req, res, rateTier))) {
      return 'blocked';
    }
    return 'ok';
  }

  const clientO = getRequestOriginClient(req);
  if (!isAllowedClientOrigin(clientO)) {
    if (req.method === 'OPTIONS') {
      if (typeof res.status === 'function') {
        res.status(403).json({ error: 'forbidden', message: 'CORS' });
        return 'blocked';
      }
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'forbidden', message: 'CORS' }));
      return 'blocked';
    }
    if (typeof res.status === 'function') {
      res.status(403).json({ error: 'forbidden', message: 'Origin not allowed' });
      return 'blocked';
    }
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'forbidden', message: 'Origin not allowed' }));
    return 'blocked';
  }

  setCorsHeadersForOrigin(res, clientO);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return 'blocked';
  }

  if (rateTier !== 'none' && !(await rateLimitOrPass(req, res, rateTier))) {
    return 'blocked';
  }

  return 'ok';
}
