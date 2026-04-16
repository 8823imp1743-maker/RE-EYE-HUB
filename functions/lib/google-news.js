import { createHash } from 'crypto';
import { getRedis } from './redis.js';
import { httpsFetch } from './http.js';

const CACHE_PREFIX = 'intel:srcurl:'; // 直リンクキャッシュ（60日）
const CACHE_TTL_SEC = 60 * 24 * 60 * 60;

function sha20(s) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 20);
}

function isGoogleNewsHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'news.google.com' || h.endsWith('.news.google.com');
}

function extractUrlParamIfAny(u) {
  try {
    const url = new URL(u);
    const p = url.searchParams.get('url') || url.searchParams.get('q');
    if (p && /^https?:\/\//i.test(p)) return p;
  } catch (_) {}
  return null;
}

/**
 * Google News URL の /articles/{articleId} から Base64 デコードで直接 URL を抽出する。
 *
 * Google News のアーティクルID はプロトバフ形式のバイナリを Base64url エンコードしたもの。
 * バイナリ構造: [0x08][varint][0x22][length][URL bytes...]
 * → HTTP リクエスト不要でGoogle の JS ガードを完全バイパスできる。
 *
 * @param {string} googleNewsUrl
 * @returns {string|null}  記事元 URL（失敗時 null）
 */
function decodeGoogleNewsUrl(googleNewsUrl) {
  try {
    const u = new URL(googleNewsUrl);
    if (!isGoogleNewsHost(u.hostname)) return null;

    // /articles/ または /rss/articles/ の後の ID を抽出
    const match = u.pathname.match(/\/articles\/([^/?#]+)/);
    if (!match) return null;

    const articleId = match[1];

    // URL-safe Base64 → 標準 Base64 + パディング補完
    const base64 = articleId.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - articleId.length % 4) % 4);

    const bytes = Buffer.from(base64, 'base64');
    const bin   = bytes.toString('latin1'); // バイト値を 1:1 で保持

    // Base64 内に複数の URL が含まれる場合があるため全出現を走査し
    // 「Google ドメイン以外の最初の有効な URL」を採用する
    for (const proto of ['https://', 'http://']) {
      let searchFrom = 0;
      while (searchFrom < bin.length) {
        const idx = bin.indexOf(proto, searchFrom);
        if (idx === -1) break;

        let end = idx;
        // ASCII 印字可能文字（0x20–0x7E）の範囲内だけ URL として採用
        while (end < bin.length &&
               bin.charCodeAt(end) >= 0x20 &&
               bin.charCodeAt(end) <= 0x7E) {
          end++;
        }

        const candidate = bin.slice(idx, end).trim();
        try {
          const parsed = new URL(candidate);
          // Google ドメインは採用しない（リダイレクト先でなく元記事が欲しい）
          if (!isGoogleNewsHost(parsed.hostname) &&
              !parsed.hostname.endsWith('.google.com') &&
              !parsed.hostname.endsWith('.googleapis.com')) {
            return candidate;
          }
        } catch (_) {}

        searchFrom = idx + proto.length; // 次の出現を探す
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Google News のリンクを「記事元の直URL」へ解決する。
 *
 * 優先順位:
 *   1. Base64 デコード直接抽出（HTTP 不要・最速・ガードバイパス）
 *   2. ?url= クエリパラメータ直取り
 *   3. Redis キャッシュ（過去の解決結果）
 *   4. HTTP リダイレクト追跡（最終手段・Google がブロックする場合あり）
 *
 * Google News URL のまま解決できなかった場合は resolveError: true を返す。
 * 呼び出し元は Google News URL を archive.org 等に絶対に渡してはならない。
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opt]
 * @returns {Promise<{ sourceUrl: string|null, newsUrl: string, fromCache: boolean, resolveError: boolean }>}
 */
export async function resolveGoogleNewsToSource(url, opt = {}) {
  const newsUrl = String(url || '');
  if (!newsUrl) return { sourceUrl: null, newsUrl: '', fromCache: false, resolveError: true };

  let parsed;
  try { parsed = new URL(newsUrl); } catch (_) {
    return { sourceUrl: null, newsUrl, fromCache: false, resolveError: true };
  }

  // Google News でなければそのまま返す（エラーなし）
  if (!isGoogleNewsHost(parsed.hostname)) {
    return { sourceUrl: newsUrl, newsUrl, fromCache: false, resolveError: false };
  }

  // ── 1. Base64 デコード直接抽出（最優先・HTTP 不要）──────────────────────
  const decoded = decodeGoogleNewsUrl(newsUrl);
  if (decoded) {
    console.log(`[google-news] Base64 decode success: ${decoded.slice(0, 80)}`);
    // 非同期でキャッシュ書き込み（失敗しても続行）
    const cacheKey = CACHE_PREFIX + sha20(newsUrl);
    let redis = null;
    try { redis = getRedis(); } catch (_) {}
    if (redis) { redis.set(cacheKey, decoded, { ex: CACHE_TTL_SEC }).catch(() => {}); }
    return { sourceUrl: decoded, newsUrl, fromCache: false, resolveError: false };
  }

  // ── 2. ?url= クエリパラメータ直取り ─────────────────────────────────────
  const fromParam = extractUrlParamIfAny(newsUrl);
  if (fromParam) {
    return { sourceUrl: fromParam, newsUrl, fromCache: false, resolveError: false };
  }

  // ── 3. Redis キャッシュ ─────────────────────────────────────────────────
  const cacheKey = CACHE_PREFIX + sha20(newsUrl);
  let redis = null;
  try { redis = getRedis(); } catch (_) {}

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached && typeof cached === 'string') {
        return { sourceUrl: cached, newsUrl, fromCache: true, resolveError: false };
      }
    } catch (_) {}
  }

  // ── 4. 完全ステルス・フェッチ（最終手段）────────────────────────────────
  // Base64 デコードが効かない AU_ 等の新形式 URL 向け。
  // iPhone Safari を完全模倣したヘッダーで Google を欺き、
  // 3xx リダイレクト追跡 + HTML レスポンス内 URL 多段抽出の2段攻め。
  //
  // ★ クエリパラメータをフェッチ前に除去する（400 回避）
  //   RSS フィードが付加する ?oc=5 / ?hl=ja&gl=JP&ceid=JP:ja 等は記事転送ゲートに
  //   不要なだけでなく、未知クエリとして厳格バリデーションで 400 を引き起こす。
  //   キャッシュキーは元の URL（パラメータ付き）を維持し Redis の既存エントリを保護する。
  const fetchUrl = (() => {
    try {
      const u = new URL(newsUrl);
      return `${u.protocol}//${u.hostname}${u.pathname}`;
    } catch (_) { return newsUrl; }
  })();
  try {
    const stealthResult = await stealthFetchGoogleNews(fetchUrl, opt.timeoutMs || 15000);
    if (stealthResult) {
      console.log(`[google-news] Stealth fetch success: ${stealthResult.slice(0, 80)}`);
      if (redis) { redis.set(cacheKey, stealthResult, { ex: CACHE_TTL_SEC }).catch(() => {}); }
      return { sourceUrl: stealthResult, newsUrl, fromCache: false, resolveError: false };
    }
  } catch (_) {}

  console.warn(`[google-news] All methods failed: ${newsUrl.slice(0, 80)}`);
  return { sourceUrl: null, newsUrl, fromCache: false, resolveError: true };
}

// ──────────────────────────────────────────────────────────────────────────────
// ステルス・フェッチ実装
// ──────────────────────────────────────────────────────────────────────────────

/**
 * iPhone Safari を完全模倣したヘッダーで Google News URL をフェッチし、
 * 記事元の実 URL を力ずくで抽出する。
 *
 * 攻略順序:
 *   1. 3xx リダイレクト追跡（httpsFetch が自動処理）
 *   2. data-n-au 属性（Google News HTML 固有の隠し実URL）
 *   3. meta http-equiv refresh
 *   4. window.location.replace / .href
 *   5. <link rel="canonical">
 *   6. og:url
 *   7. JSON-LD url フィールド
 *
 * @param {string} newsUrl
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
// ── ステルス UA プロファイル（Chrome 131 完全フィンガープリント）──────────
// Googleが「人間のブラウザ」と認識しやすい順に並べる。
// 各プロファイルはリトライ時に順番に使用する。
const STEALTH_PROFILES = [
  {
    // Chrome 131 Windows — Google の自社ブラウザに最も甘い
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.205 Safari/537.36',
    extra: {
      'Sec-CH-UA':          '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-CH-UA-Mobile':   '?0',
      'Sec-CH-UA-Platform': '"Windows"',
    },
    referer: 'https://news.google.com/',
  },
  {
    // Chrome 131 Android — モバイルは検証が緩い傾向
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36',
    extra: {
      'Sec-CH-UA':          '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-CH-UA-Mobile':   '?1',
      'Sec-CH-UA-Platform': '"Android"',
    },
    referer: 'https://news.google.com/',
  },
  {
    // iPhone Safari — Bot判定が最も甘いプロファイル
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
    extra: {
      'Sec-CH-UA-Mobile':   '?1',
      'Sec-CH-UA-Platform': '"iOS"',
    },
    referer: 'https://www.google.co.jp/',
  },
  {
    // Chrome 131 Mac — 3番手として使用
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.205 Safari/537.36',
    extra: {
      'Sec-CH-UA':          '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-CH-UA-Mobile':   '?0',
      'Sec-CH-UA-Platform': '"macOS"',
    },
    referer: 'https://news.google.com/',
  },
];

async function stealthFetchGoogleNews(newsUrl, timeoutMs = 15000) {
  // 全プロファイルで順番に試みる
  for (const profile of STEALTH_PROFILES) {
    try {
      const r = await httpsFetch(newsUrl, {
        method:       'GET',
        timeoutMs:    Math.floor(timeoutMs / STEALTH_PROFILES.length) + 3000,
        maxRedirects: 10,
        headers: {
          'User-Agent':                profile.ua,
          'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language':           'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding':           'gzip, deflate', // br は Node.js 非対応のため除外
          'Cache-Control':             'max-age=0',
          'Connection':                'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          // ── Sec-Fetch-* は削除 ──────────────────────────────────────────────
          // ブラウザ専用ヘッダーをサーバーから送ると Google が矛盾を検知して 400 を返す
          // （stealth.js 設計原則と同じ理由で除外）
          'DNT':                       '1',
          'Referer':                   profile.referer,
          ...profile.extra,
        },
      });

      // 3xx リダイレクトで Google ドメインを脱出した場合は即採用
      if (r.finalUrl) {
        try {
          const f = new URL(r.finalUrl);
          if (!isGoogleNewsHost(f.hostname)) {
            console.log(`[google-news] Stealth 3xx escape [${profile.ua.slice(0, 30)}]: ${r.finalUrl.slice(0, 60)}`);
            return r.finalUrl;
          }
        } catch (_) {}
      }

      // HTML 多段抽出
      const extracted = extractRedirectFromHtml(r.body || '');
      if (extracted) {
        console.log(`[google-news] Stealth HTML extract [${profile.ua.slice(0, 30)}]: ${extracted.slice(0, 60)}`);
        return extracted;
      }

      console.warn(`[google-news] Stealth profile failed (no URL): ${profile.ua.slice(0, 30)}`);
    } catch (e) {
      console.warn(`[google-news] Stealth profile error [${profile.ua.slice(0, 30)}]: ${e.message}`);
    }
  }
  return null;
}

/**
 * Google News が返す HTML から記事元 URL を抽出する多段パーサー。
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractRedirectFromHtml(html) {
  if (!html) return null;

  /** 非 Google URL として有効なら返す、それ以外 null */
  const accept = (u) => {
    if (!u) return null;
    const s = String(u).trim().replace(/\\u003d/gi, '=').replace(/\\u0026/gi, '&');
    if (!/^https?:\/\//i.test(s)) return null;
    try { if (!isGoogleNewsHost(new URL(s).hostname)) return s; } catch (_) {}
    return null;
  };

  // ── 優先度A：Google News HTML に直接埋め込まれた実URL ─────────────────

  // A-1. data-n-au 属性（最確実 — Google News article 要素固有）
  for (const m of html.matchAll(/data-n-au="([^"]+)"/g)) {
    const r = accept(m[1]); if (r) return r;
  }

  // A-2. data-url 属性（一部の Google News コンポーネント）
  for (const m of html.matchAll(/data-url="(https?:[^"]+)"/g)) {
    const r = accept(m[1]); if (r) return r;
  }

  // A-3. Google News 記事リンク固有クラス (DY5T1d / VDXfz / WwrzSb)
  for (const cls of ['DY5T1d', 'VDXfz', 'WwrzSb', 'RZIKme']) {
    const re = new RegExp(`class="[^"]*${cls}[^"]*"[^>]*href="(https?:[^"]+)"`, 'i');
    const m = html.match(re) ||
              html.match(new RegExp(`href="(https?:[^"]+)"[^>]*class="[^"]*${cls}[^"]*"`, 'i'));
    if (m) { const r = accept(m[1]); if (r) return r; }
  }

  // ── 優先度B：JavaScript 埋め込みデータ ────────────────────────────────

  // B-1. AF_initDataCallback（Google の汎用データ注入 — AU_ リンクに頻出）
  const afCallbacks = html.matchAll(/AF_initDataCallback\s*\(\s*\{[^}]*data\s*:\s*(\[[\s\S]{1,4000}?\])\s*[,}]/g);
  for (const cb of afCallbacks) {
    try {
      const raw = cb[1].replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      const urls = raw.match(/"(https?:\/\/[^"]{10,300})"/g) || [];
      for (const u of urls) {
        const r = accept(u.slice(1, -1)); if (r) return r;
      }
    } catch (_) {}
  }

  // B-2. _initDefaults / bootstrap data  "articleUrl":"..."
  const articleUrl = html.match(/"articleUrl"\s*:\s*"(https?:[^"]+)"/) ||
                     html.match(/"originalUrl"\s*:\s*"(https?:[^"]+)"/) ||
                     html.match(/"readUrl"\s*:\s*"(https?:[^"]+)"/);
  if (articleUrl) { const r = accept(articleUrl[1]); if (r) return r; }

  // B-3. window.location 代入 / replace
  const winLoc = html.match(
    /window\.location(?:\.replace\s*\(\s*|\.href\s*=\s*)["'`](https?:[^"'`\s]{10,})["'`]/,
  );
  if (winLoc) { const r = accept(winLoc[1]); if (r) return r; }

  // ── 優先度C：標準 HTML メタ情報 ───────────────────────────────────────

  // C-1. meta http-equiv refresh
  const metaRefresh = html.match(
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'\s>]+)/i,
  );
  if (metaRefresh) { const r = accept(metaRefresh[1].replace(/["'>]/g, '')); if (r) return r; }

  // C-2. <link rel="canonical">
  const canonical =
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  if (canonical) { const r = accept(canonical[1]); if (r) return r; }

  // C-3. og:url
  const ogUrl =
    html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
  if (ogUrl) { const r = accept(ogUrl[1]); if (r) return r; }

  // C-4. JSON-LD "url" フィールド
  const jsonLd = html.match(/"url"\s*:\s*"(https?:\/\/(?!news\.google\.)[^"]{10,})"/);
  if (jsonLd) { const r = accept(jsonLd[1]); if (r) return r; }

  return null;
}
