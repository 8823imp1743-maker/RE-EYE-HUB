import { searchAllCached } from './shop-search-cache.js';
import { itemCanonicalKey } from './stock-dedupe.js';

const DEFAULT_HITS = 20;

/**
 * キーワードごとに同じ mall ページ（楽天 page / Yahoo start）を取り、合流（kwList 順・各 kw 内は searchAll 規約）
 * @param {string[]} kwList
 * @param {number} mallPage 1 始まり
 * @param {number} [maxHits]
 * @returns {Promise<{ allItems: object[], shopResults: PromiseSettledResult[] }>}
 */
export async function fetchMallPageSliceForKeywordList(kwList, mallPage, maxHits = DEFAULT_HITS) {
  const p = Math.max(1, Math.floor(mallPage));
  const hits = Math.max(1, Math.min(30, maxHits));
  const yahooStart = (p - 1) * hits + 1;

  const shopResults = await Promise.allSettled(
    (kwList || []).map((kw) =>
      searchAllCached(kw, {
        maxResults: hits,
        inStockOnly: false,
        skipCache: true,
        page: p,
        yahooStart,
      })
    )
  );

  const allItems = [];
  shopResults.forEach((r) => {
    if (r.status === 'fulfilled' && r.value?.items) allItems.push(...r.value.items);
  });
  return { allItems, shopResults };
}

/**
 * 取得済み行にユニーク追加（key = sourceId:itemId）
 * @param {object[]} acc
 * @param {object[]} batch
 * @param {Set<string>} seen
 */
export function pushUniqueMallItems(acc, batch, seen) {
  for (const it of batch || []) {
    const k = itemCanonicalKey(it);
    if (!k || k === ':') continue;
    if (seen.has(k)) continue;
    seen.add(k);
    acc.push(it);
  }
}
