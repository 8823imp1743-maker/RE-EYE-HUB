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
export async function fetchMallPageSliceForKeywordList(
  kwList,
  mallPage,
  maxHits = DEFAULT_HITS,
  mallOptions = {}
) {
  const p = Math.max(1, Math.floor(mallPage));
  const hits = Math.max(1, Math.min(30, maxHits));
  const yahooStart = (p - 1) * hits + 1;
  const {
    shoeSearchIntent = false,
    userGender = 'unknown',
    mallPreserveTokens = [],
  } = mallOptions;

  const shopResults = await Promise.allSettled(
    (kwList || []).map((kw) =>
      searchAllCached(kw, {
        maxResults: hits,
        inStockOnly: false,
        skipCache: true,
        page: p,
        yahooStart,
        shoeSearchIntent,
        userGender,
        mallPreserveTokens,
      })
    )
  );

  const allItems = [];
  const meta = { marketRaw: 0, noiseExcluded: 0, apparelPollution: 0 };
  shopResults.forEach((r) => {
    if (r.status === 'fulfilled' && r.value) {
      if (Array.isArray(r.value.items)) allItems.push(...r.value.items);
      const s = r.value.rejectReasonSummary || {};
      if (Number.isFinite(Number(s.marketRaw))) meta.marketRaw += Number(s.marketRaw) || 0;
      if (Number.isFinite(Number(s.noiseExcluded))) meta.noiseExcluded += Number(s.noiseExcluded) || 0;
      if (Number.isFinite(Number(s.apparelPollution))) {
        meta.apparelPollution += Number(s.apparelPollution) || 0;
      }
    }
  });
  return { allItems, shopResults, meta };
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
