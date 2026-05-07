/**
 * Vercel /api/search 専用: 同一インスタンス内メモリキャッシュ + 軽い間引き + IPバースト抑制。
 * 検索ロジック・結果内容は変更しない（キャッシュヒット時のみ JSON に cached: true を付与）。
 *
 * LOCK（最終確定）— キャッシュキー粒度:
 * - `keyword` のみでのキー化は禁止（ページ違いで同一 JSON を返す事故になる）。
 * - 正: `POST` の **req.body 全フィールド**を安定シリアライズ（searchCacheKey）。
 *   functions/api/search.js が参照する例: keyword, userId, forChild, offset, limit,
 *   excludeKeys, excludeSellerModelKeys, prePdpScanIndex, sequentialPdp, plan, multiTargetCm ほか。
 * - 当APIに独立の sort/page クエリは無い（ページングは offset / prePdpScanIndex）。
 *
 * Vercel プロセス単位 Map のためインスタンス間でキャッシュは共有されない。
 * 意図どおり（0円・単純・事故りにくい）。共有が要る場合のみ Redis 等の別フェーズで。
 */
import { getClientIpForRateLimit } from './_security.js';

const CACHE_TTL_MS = 30000;
const CACHE_MAX_KEYS = 600;
const IP_WINDOW_MS = 5000;
/** 5秒窓で 6 回目から拒否（recent.length > 5） */
const IP_BURST_THRESHOLD = 5;
const MIN_GAP_MS = 300;

const cache = new Map();
let lastCallTime = 0;
const ipHits = new Map();

function deepCloneJson(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** 配列順は維持（excludeKeys 等）。オブジェクトはキー昇順で安定化。 */
function stableStringify(val) {
  if (val === null) return 'null';
  const t = typeof val;
  if (t === 'number' || t === 'boolean') return JSON.stringify(val);
  if (t === 'string') return JSON.stringify(val);
  if (Array.isArray(val)) {
    return `[${val.map(stableStringify).join(',')}]`;
  }
  if (t === 'object') {
    const keys = Object.keys(val).sort();
    return `{${keys.map((k) => JSON.stringify(k) + ':' + stableStringify(val[k])).join(',')}}`;
  }
  return JSON.stringify(val);
}

function searchCacheKey(body) {
  const b = body && typeof body === 'object' ? body : {};
  return stableStringify(b);
}

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data) {
  cache.set(key, {
    data: deepCloneJson(data),
    ts: Date.now(),
  });
  while (cache.size > CACHE_MAX_KEYS) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function checkIpBurst(ipRaw) {
  const ip = String(ipRaw || 'unknown').slice(0, 128);
  const now = Date.now();
  let hits = ipHits.get(ip) || [];
  hits = hits.filter((t) => now - t < IP_WINDOW_MS);
  if (hits.length > IP_BURST_THRESHOLD) return false;
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 8000) {
    for (const k of ipHits.keys()) {
      ipHits.delete(k);
      if (ipHits.size < 4000) break;
    }
  }
  return true;
}

async function waitIfNeeded() {
  const now = Date.now();
  if (now - lastCallTime < MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_GAP_MS));
  }
  lastCallTime = Date.now();
}

function applySetNoStore(res) {
  try {
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } catch (_) {
    /* ignore */
  }
}

function createCaptureResponse() {
  let statusCode = 200;
  /** @type {unknown} */
  let payload;
  let ended = false;

  const cap = {
    setHeader() {
      /* キャプチャ時はヘッダ反映しない。転送時に必要なものは下で付与 */
    },
    get writableEnded() {
      return ended;
    },
    status(code) {
      statusCode = code;
      return {
        json(body) {
          payload = body;
          ended = true;
        },
      };
    },
  };

  return {
    res: cap,
    outcome() {
      return { statusCode, payload, ended };
    },
  };
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {(req:any, res:any) => unknown} searchHandler
 */
export async function applySearchMemoryShield(req, res, searchHandler) {
  if (process.env.RE_EYE_DISABLE_SEARCH_MEM_SHIELD === '1') {
    return searchHandler(req, res);
  }

  const ip = getClientIpForRateLimit(req);
  if (!checkIpBurst(ip)) {
    if (typeof res.status === 'function') {
      res.setHeader('Retry-After', '5');
      return res.status(429).json({
        error: 'too_many_requests',
        message: '短時間のアクセスが多すぎます。しばらく待ってください。',
      });
    }
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Retry-After', '5');
    return res.end(
      JSON.stringify({
        error: 'too_many_requests',
        message: '短時間のアクセスが多すぎます。しばらく待ってください。',
      })
    );
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const key = searchCacheKey(body);
  const cached = getCached(key);
  if (cached != null) {
    const out = deepCloneJson(cached);
    if (typeof out === 'object' && out !== null) {
      out.cached = true;
    }
    applySetNoStore(res);
    if (typeof res.status === 'function') {
      return res.status(200).json(out);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    applySetNoStore(res);
    return res.end(JSON.stringify(out));
  }

  await waitIfNeeded();

  const { res: capRes, outcome } = createCaptureResponse();
  try {
    await searchHandler(req, capRes);
  } catch (e) {
    console.error('[api/search-memory] handler throw', e && e.message);
    if (typeof res.status === 'function') {
      return res.status(500).json({ error: e?.message || 'internal_error' });
    }
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: e?.message || 'internal_error' }));
  }

  const { statusCode, payload, ended } = outcome();
  if (!ended || payload === undefined) {
    if (typeof res.status === 'function') {
      return res.status(500).json({ error: 'empty_handler_response' });
    }
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'empty_handler_response' }));
  }

  if (statusCode === 200) {
    setCached(key, payload);
    applySetNoStore(res);
    const fresh = deepCloneJson(payload);
    if (typeof res.status === 'function') {
      return res.status(200).json(fresh);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    applySetNoStore(res);
    return res.end(JSON.stringify(fresh));
  }

  if (typeof res.status === 'function') {
    return res.status(statusCode).json(payload);
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(payload));
}
