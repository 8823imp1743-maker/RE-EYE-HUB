/**
 * 在庫検索の「同一店舗・同一品番」多様性用キー
 */
import { buildSerpPlainTextHaystack } from './color-filter.js';
import { extractModelNumbers } from './cross-validator.js';

export function itemCanonicalKey(item) {
  if (!item) return '';
  return `${String(item.sourceId || '')}:${String(item.itemId || '')}`;
}

/**
 * 商品 URL から店舗らしさを抜す（API に seller 名がないとき）
 * @param {string} [url]
 * @param {string} [sourceId]
 * @returns {string}
 */
export function shopHintFromUrl(url, sourceId) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  try {
    const u = new URL(url);
    const h = (u.hostname || '').toLowerCase();
    if (h.includes('rakuten') || h === 'item.rakuten.co.jp') {
      const p = u.pathname.split('/').filter(Boolean);
      if (p.length >= 1) return p[0].toLowerCase();
    }
    if (h.includes('yahoo') || h.includes('shopping') || h.includes('store.shopping')) {
      const p = u.pathname.split('/').filter(Boolean);
      if (p.length >= 0) return (p[0] || u.hostname).toLowerCase();
    }
    return u.hostname;
  } catch {
    return '';
  }
}

/**
 * 店舗＋主型番。同一キーは一覧で並べたくない（次へで多様性）
 * @param {object} item
 * @returns {string}
 */
export function sellerModelDedupeKey(item) {
  if (!item) return '';
  const sellerRaw =
    (item.sellerName && String(item.sellerName).trim()) ||
    shopHintFromUrl(item.url, item.sourceId) ||
    (item.shopName && String(item.shopName).trim()) ||
    '';
  const seller = String(sellerRaw)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'na';
  const hay = buildSerpPlainTextHaystack(item);
  const models = extractModelNumbers(hay) || extractModelNumbers(String(item.title || ''));
  const m = (Array.isArray(models) && models[0] && String(models[0])) || String(item.itemId || '').slice(0, 32);
  return `${seller}::${m.toUpperCase()}`;
}
