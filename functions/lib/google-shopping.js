/**
 * @deprecated 運用ポリシー: SerpAPI / Google Shopping 呼び出しはコスト削減のため
 *   本番の search / monitor パスからは外しました。ファイルは後方互換のため残置。
 *
 * SerpAPI Google Shopping — 第3の目（V11強化版）
 *
 * 「楽天・Yahoo の外側にある在庫を見る」
 *
 * SerpAPI は Google Shopping の構造化データを直接返す。
 * CSE のスニペット解析ではなく、価格・ショップ名・URL が
 * フィールドとして取得できるため、SERP URL 差分検知に直接使える。
 *
 * 相乗りキャッシュ: TTL 5分で Redis にキャッシュ。
 * 複数ユーザーが同じ商品を監視していても SerpAPI コールは1回に抑える。
 *
 * ── 費用 ─────────────────────────────────────────────────────────────────
 *   SerpAPI 無料: 100クエリ/月
 *   有料: $50/5000クエリ（$0.01/クエリ = 約1.5円/クエリ）
 *   VIP プランで1分監視 → 最大 1440クエリ/日 → 相乗りキャッシュで実質 200〜400クエリ/日
 *
 * ── SerpAPI パラメータ ───────────────────────────────────────────────────
 *   engine=google_shopping  : Google ショッピング結果
 *   gl=jp                   : 日本市場
 *   hl=ja                   : 日本語
 *   num=20                  : 最大20件
 */

import { createHash } from 'crypto';
import { getRedis }   from './redis.js';
import { safeCall }   from './quota-manager.js';

const SERPAPI_BASE   = 'https://serpapi.com/search.json';
const TIMEOUT_MS     = 8000;
const CACHE_TTL      = 300; // 5分（相乗りキャッシュ）

// ── 信頼できる公式・大手 ECサイト ─────────────────────────────────────────
const TRUSTED_DOMAINS = [
  'nike.com', 'abc-mart.net', 'atmos-tokyo.com', 'shop.atmos.jp',
  'reebok.com', 'adidas.com', 'new-balance.jp', 'converse.co.jp',
  'asics.com', 'puma.com', 'vans.com',
  'zozo.jp', 'ships-ltd.co.jp', 'united-arrows.co.jp', 'beams.co.jp',
  'journal-standard.jp', 'urban-research.co.jp', 'tomorrowland.jp',
  'coach.com', 'jp.louisvuitton.com', 'gucci.com', 'prada.com',
  'kate-spade.com', 'michaelkors.com', 'furla.com', 'longchamp.com',
  'tory-burch.jp', 'miumiu.com', 'balenciaga.com',
  'uniqlo.com', 'zara.com', 'hm.com', 'gap.co.jp', 'muji.com',
  'gu-global.com',
  'montbell.jp', 'goldwin.jp', 'descente.co.jp',
  'z-craft.jp', 'foot-locker.co.jp', 'snkrdunk.com',
  'sneakersnstuff.com', 'concepts.com', 'doverstreetmarket.com',
  'union-tokyo.com', 'kicks-lab.com', 'mita-sneakers.co.jp',
  'billy-s.jp', 'hanon-shop.com',
  'lacoste.jp', 'amazon.co.jp',
];

// ── 在庫なしを示す明確なシグナル ─────────────────────────────────────────
const OUTOFSTOCK_SIGNALS = [
  '在庫切れ', '売り切れ', '品切れ', 'SOLD OUT', 'sold out',
  '只今品切れ', '入荷待ち', '完売', '在庫なし', '取り扱い終了',
];

// ── 中古・転売フィルター（Google Shopping には中古も混入する）──────────────
const USED_SIGNALS = [
  'メルカリ', 'ヤフオク', '中古', 'USED', 'used', '古着',
  'セカンドストリート', 'ラクマ',
];

/**
 * URL が信頼できる大手ショップかを判定する。
 */
function isTrustedDomain(url) {
  return TRUSTED_DOMAINS.some(d => (url || '').includes(d));
}

/**
 * タイトル・ショップ名が中古・転売品かを判定する。
 */
function isUsedOrResale(text) {
  const t = (text || '').toLowerCase();
  return USED_SIGNALS.some(s => t.includes(s.toLowerCase()));
}

/**
 * SerpAPI shopping_results のアイテムを shop-adapter 互換フォーマットに変換する。
 * @param {object} item  SerpAPI shopping result item
 * @returns {{ title, url, price, available, sourceId, thumbnail } | null}
 */
function normalizeItem(item) {
  const url = item.link || item.product_link || '';
  if (!url || !url.startsWith('http')) return null;

  // 中古・転売ショップは除外
  if (isUsedOrResale(`${item.source || ''} ${item.title || ''}`)) return null;

  const price = item.extracted_price || 0;
  const title = item.title || '';
  const shop  = item.source || new URL(url).hostname;

  // 品切れシグナルがタイトル・拡張情報に含まれる場合は在庫なし
  const tags = [
    ...(item.extensions || []),
    item.tag || '',
    title,
  ].join(' ');
  const available = !OUTOFSTOCK_SIGNALS.some(s => tags.includes(s));

  return {
    title,
    url,
    price,
    available,
    sourceId:  'google_shopping',
    thumbnail: item.thumbnail || '',
    shop,
  };
}

/**
 * SerpAPI Google Shopping で商品を横断検索する。
 *
 * @param {string}      searchTerm  検索クエリ（Vibe クエリ推奨）
 * @param {{ type: string, raw: string }|null} sizeInfo  サイズ情報（null可）
 * @returns {Promise<{
 *   signal: 'size_confirmed_in_stock'|'size_confirmed_out'|'market_found'|'not_found'|'error',
 *   items:  Array<{ title, url, price, available, sourceId }>
 * }>}
 */
export async function searchGoogleShopping(searchTerm, sizeInfo = null) {
  const apiKey = (process.env.SERPAPI_KEY || '').trim();

  if (!apiKey) {
    console.log('[google-shopping] SERPAPI_KEY 未設定 → スキップ');
    return { signal: 'error', items: [] };
  }

  // ── 相乗りキャッシュ確認 ──────────────────────────────────────────────────
  const cacheKey = `serp:shopping:${createHash('sha256')
    .update(`${searchTerm}:${sizeInfo?.raw || ''}`)
    .digest('hex')
    .slice(0, 16)}`;

  try {
    const r      = getRedis();
    const cached = await r.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      console.log(
        `[google-shopping] 相乗りキャッシュHIT: "${searchTerm.slice(0, 40)}"` +
        ` signal=${parsed.signal} items=${parsed.items?.length ?? 0}`
      );
      return parsed;
    }
  } catch { /* キャッシュミスはサイレント */ }

  // ── サイズ文字列を付加 ────────────────────────────────────────────────────
  const sizeStr = sizeInfo?.type === 'shoe'
    ? `${sizeInfo.raw}cm`
    : (sizeInfo?.raw || '');

  const query = [
    searchTerm,
    sizeStr,
    '-中古',
    '-USED',
    '-ヤフオク',
    '-メルカリ',
  ].filter(Boolean).join(' ');

  const params = new URLSearchParams({
    engine:  'google_shopping',
    q:       query,
    api_key: apiKey,
    gl:      'jp',
    hl:      'ja',
    num:     '20',
  });

  // safeCall: quota超過時は null → error を返してキャッシュしない
  let fetchedJson = null;
  try {
    fetchedJson = await safeCall('serpapi', async () => {
      const res = await Promise.race([
        fetch(`${SERPAPI_BASE}?${params}`, { headers: { Accept: 'application/json' } }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('serpapi-timeout')), TIMEOUT_MS)
        ),
      ]);
      if (!res.ok) {
        // 429 は safeCall 内で quotaLock されるようエラーを throw
        throw new Error(`serpapi-http-${res.status}`);
      }
      return res.json();
    });
  } catch (e) {
    console.warn(`[google-shopping] SerpAPI error (${searchTerm.slice(0, 40)}):`, e.message?.slice(0, 80));
    return { signal: 'error', items: [] };
  }

  if (fetchedJson === null) {
    // quota blocked — 課金なし
    return { signal: 'error', items: [] };
  }

  try {
    const raw = fetchedJson.shopping_results || [];

    if (raw.length === 0) {
      console.log(`[google-shopping] "${searchTerm.slice(0, 40)}" 結果0件`);
      const result = { signal: 'not_found', items: [] };
      await _cache(cacheKey, result);
      return result;
    }

    // ── 正規化 ──────────────────────────────────────────────────────────────
    const items = raw.map(normalizeItem).filter(Boolean);

    const inStockItems  = items.filter(i => i.available && i.price > 0);
    const trustedStock  = inStockItems.filter(i => isTrustedDomain(i.url));
    const trustedFound  = items.filter(i => isTrustedDomain(i.url)).length;
    const outOfStock    = raw.length - items.length; // 除外済み（中古）+ 在庫なし

    console.log(
      `[google-shopping] "${searchTerm.slice(0, 40)}" ` +
      `在庫あり${inStockItems.length}件(公式${trustedStock.length}件)` +
      ` 公式取扱${trustedFound}件 計${items.length}件`
    );

    items.forEach(item => {
      console.log(
        `[google-shopping] ${item.available ? '✅' : '❌'} ${item.shop}: ` +
        `"${item.title.slice(0, 40)}" ¥${item.price.toLocaleString()} → ${item.url.slice(0, 60)}`
      );
    });

    // ── シグナル判定 ─────────────────────────────────────────────────────────
    let signal;
    if (inStockItems.length > 0) {
      signal = 'size_confirmed_in_stock';
    } else if (outOfStock > 0 && inStockItems.length === 0 && trustedFound === 0) {
      signal = 'size_confirmed_out';
    } else if (trustedFound > 0) {
      signal = 'market_found';
    } else {
      signal = 'not_found';
    }

    const result = { signal, items };
    await _cache(cacheKey, result);
    return result;

  } catch (e) {
    console.warn(`[google-shopping] 例外 (${searchTerm.slice(0, 40)}):`, e.message);
    return { signal: 'error', items: [] };
  }
}

/** Redis キャッシュ書き込みヘルパー */
async function _cache(key, value) {
  try {
    const r = getRedis();
    await r.set(key, JSON.stringify(value), { ex: CACHE_TTL });
  } catch { /* キャッシュ書き込み失敗はサイレント */ }
}
