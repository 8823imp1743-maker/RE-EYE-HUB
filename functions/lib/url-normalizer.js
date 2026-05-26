/**
 * url-normalizer.js
 *
 * URL正規化 + 監視品質スコアリング。
 *
 * 目的:
 *   discover で収集した URL 群から「監視する価値のある商品URL」だけを抽出する。
 *   検索ページ・広告・無限パラメータURLを弾き、楽天/Yahoo/公式の商品詳細を残す。
 *
 * スコア基準（100点満点）:
 *   +30: 商品詳細URL（/item/ /product/ /detail/ 等）
 *   +20: タイトルにキーワード含む
 *   +15: 楽天/Yahoo/公式ECドメイン
 *   +10: 価格情報あり
 *    -50: 検索ページURL（/search/ /s? /q= 等）
 *    -30: 短縮URL・リダイレクト系（amzn.to / bit.ly 等）
 *    -20: 広告/アフィリエイトパラメータ過多（3個以上）
 */

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'scid', 'ref', 'sc_e', 'sc_i', 'sc_pt', 'sc_qs', 'sc_ts',
  'icid', 'tag', 'linkCode', 'creative', 'creativeASIN',
  'gclid', 'fbclid', 'msclkid', 'yclid',
];

const PRODUCT_URL_PATTERNS = [
  /\/item\//i,
  /\/product\//i,
  /\/detail\//i,
  /\/goods\//i,
  /\/p\//i,
  /\/dp\//i,
  /\/g\//i,
  /\/catalog\//i,
];

const SEARCH_PAGE_PATTERNS = [
  /\/search\//i,
  /[?&]s=/i,
  /[?&]q=/i,
  /[?&]keyword=/i,
  /\/list\//i,
  /\/category\//i,
  /\/genre\//i,
];

const SHORT_URL_DOMAINS = [
  'amzn.to', 'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly',
];

const TRUSTED_SHOP_DOMAINS = [
  'item.rakuten.co.jp',
  'shopping.yahoo.co.jp',
  'store.shopping.yahoo.co.jp',
  'www.amazon.co.jp',
  'www.yodobashi.com',
  'www.animate-onlineshop.jp',
  'www.amiami.jp',
  'plex-shop.jp',
  'www.bandaicreative.jp',
  'ec.disney.co.jp',
  'shop.sanrio.co.jp',
  'style.pokemon.co.jp',
  'shop.chiikawamarket.jp',
];

/**
 * トラッキングパラメータを除去してURLを正規化する。
 * @param {string} url
 * @returns {string}
 */
export function normalizeProductUrl(url) {
  try {
    const u = new URL(url);
    TRACKING_PARAMS.forEach(k => u.searchParams.delete(k));
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * URL + アイテム情報から「監視する価値」スコアを算出する（0〜100）。
 * スコアが低いほどゴミURL（検索ページ・広告）の可能性が高い。
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.title]
 * @param {string} [opts.keyword]
 * @param {number} [opts.price]
 * @returns {number}
 */
export function scoreProductUrl({ url, title = '', keyword = '', price = 0 }) {
  let score = 50; // 基準点

  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    const pathname = u.pathname.toLowerCase();
    const search   = u.search.toLowerCase();

    // ── 加点 ──────────────────────────────────────────────────────────────
    if (PRODUCT_URL_PATTERNS.some(p => p.test(pathname))) score += 30;

    if (keyword && title) {
      const kwTokens = keyword.toLowerCase().split(/\s+/);
      const titleLow = title.toLowerCase();
      const hitCount = kwTokens.filter(t => t.length >= 2 && titleLow.includes(t)).length;
      score += Math.min(20, hitCount * 10);
    }

    if (TRUSTED_SHOP_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) score += 15;

    if (price > 0) score += 10;

    // ── 減点 ──────────────────────────────────────────────────────────────
    if (SEARCH_PAGE_PATTERNS.some(p => p.test(pathname + search))) score -= 50;

    if (SHORT_URL_DOMAINS.some(d => hostname === d)) score -= 30;

    const adParamCount = TRACKING_PARAMS.filter(k => u.searchParams.has(k)).length;
    if (adParamCount >= 3) score -= 20;

    // 極端に短い pathname は商品詳細でない可能性が高い
    if (pathname.length <= 3) score -= 15;

  } catch {
    score -= 40; // URL パース失敗
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * URL 候補リストを正規化 → スコアリング → 高品質順にソートして返す。
 *
 * @param {Array<{url: string, title?: string, price?: number}>} items
 * @param {object} opts
 * @param {string} [opts.keyword]
 * @param {number} [opts.minScore=40] - この点数未満は除外
 * @param {number} [opts.maxCount=5]
 * @returns {Array<{url: string, title: string, score: number}>}
 */
export function rankAndFilterUrls(items, { keyword = '', minScore = 40, maxCount = 5 } = {}) {
  const seen = new Set();
  const scored = [];

  for (const item of items) {
    const rawUrl = item.url || item.affiliateUrl || item.itemUrl || '';
    if (!rawUrl || !rawUrl.startsWith('http')) continue;

    const normalized = normalizeProductUrl(rawUrl);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const score = scoreProductUrl({
      url:     normalized,
      title:   item.title || item.name || '',
      keyword,
      price:   Number(item.price) || 0,
    });

    if (score >= minScore) {
      scored.push({ url: normalized, title: item.title || item.name || '', score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCount);
}
