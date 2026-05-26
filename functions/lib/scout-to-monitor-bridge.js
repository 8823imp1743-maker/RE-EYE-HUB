/**
 * scout-to-monitor-bridge.js
 *
 * 「キーワード登録 → URL発見 → 監視登録」の橋渡しモジュール。
 *
 * 優先順位（コスト低い順）:
 *   1. RSS（Google News） — 無料、低負荷
 *   2. 楽天/Yahoo API — 無料枠あり
 *   3. SERP（SerpAPI）— safeCall でクォータ制御済み、最終手段
 *
 * 常時Google検索は禁止。登録時の初回探索のみで使う。
 */

import { scanKeyword } from './rss-scanner.js';
import { searchAllCached } from './shop-search-cache.js';
import { rankAndFilterUrls } from './url-normalizer.js';
import { buildProductEntry, detectCategory } from './canonical-product.js';

const MAX_URLS_PER_KEYWORD = 5;

/**
 * キーワードから URL 候補を収集する。
 * 返した URL 群は monitor.js の登録フローに渡す。
 *
 * @param {object} opts
 * @param {string} opts.keyword - ユーザー登録キーワード
 * @param {'sneaker'|'standard'} [opts.mode='standard'] - 監視モード
 * @param {boolean} [opts.bypassDedup=false] - RSS 重複排除をスキップするか
 * @returns {Promise<{ keyword: string, mode: string, discoveredUrls: string[], source: string }>}
 */
export async function discoverUrlsForKeyword({ keyword, mode = 'standard', bypassDedup = false }) {
  // RSS と mall は役割が違うため分離して管理する。
  // RSS（Google News）→ 発売・再販シグナルの検出のみ。news記事URLは監視対象にしない。
  // Mall API（楽天/Yahoo）→ 実際に監視する商品URLの収集。
  const mallItems = [];
  const rssSignals = [];
  let source = 'none';

  // ── Phase 1: RSS（Google News） — シグナル検出のみ ──────────────────────────
  // 返ってくる URL は Google News 記事URLなので monitor 対象には含めない。
  // タイトルにキーワードが含まれるか（シグナル有無）だけを確認する。
  try {
    const rssResult = await scanKeyword(keyword, bypassDedup, { maxItems: 10 });
    const items = Array.isArray(rssResult?.newItems) ? rssResult.newItems : [];
    for (const item of items) {
      rssSignals.push({ title: item.title || '', pubDate: item.pubDate });
    }
    if (rssSignals.length > 0) source = 'rss';
  } catch (e) {
    console.warn('[scout-bridge] RSS scan failed:', e.message);
  }

  // ── Phase 2: 楽天/Yahoo API — 監視対象URLの収集 ─────────────────────────────
  // これだけが monitor.js に登録する URL 候補になる。
  try {
    const mallResult = await searchAllCached(keyword, {
      maxResults: 15,
      inStockOnly: false,
      skipCache: false,
    });
    const items = Array.isArray(mallResult) ? mallResult : [];
    for (const item of items) {
      const u = item.url || item.affiliateUrl || item.itemUrl || '';
      if (u && u.startsWith('http')) {
        mallItems.push({
          url:   u,
          title: item.title || item.name || '',
          price: Number(item.price) || 0,
        });
      }
    }
    if (mallItems.length > 0) source = source === 'rss' ? 'rss+mall' : 'mall';
  } catch (e) {
    console.warn('[scout-bridge] Mall search failed:', e.message);
  }

  // ── URL正規化 + 品質スコアリング（mall URLのみ対象）────────────────────────
  // 検索ページ・広告・ゴミURLを除去し、商品詳細URLだけを高品質順に返す。
  const ranked = rankAndFilterUrls(mallItems, {
    keyword,
    minScore: 35,
    maxCount: MAX_URLS_PER_KEYWORD,
  });

  const discoveredUrls = ranked.map(r => r.url);

  // カテゴリ自動検出（isShoe 判定等の mode 引数を上書き補正）
  const detectedCategory = detectCategory(keyword);
  const resolvedMode = mode !== 'standard'
    ? mode
    : (detectedCategory === 'sneaker' ? 'sneaker' : 'standard');

  // Product エントリ構築（Canonical Product Engine 統合）
  const productEntry = buildProductEntry({ keyword, urls: discoveredUrls });

  console.log(
    '[scout-bridge]',
    JSON.stringify({
      keyword, resolvedMode, source,
      mallRaw: mallItems.length,
      rssSignals: rssSignals.length,
      afterScore: discoveredUrls.length,
      topScore: ranked[0]?.score ?? 0,
      canonicalName: productEntry.canonicalName,
      category: productEntry.category,
    })
  );

  return {
    keyword,
    mode: resolvedMode,
    discoveredUrls,
    source,
    scored: ranked,
    product: productEntry,
    rssSignals,  // シグナル情報（将来の Signal Engine 用）
  };
}

/**
 * 発見した URL を monitor 登録用のエントリ配列に変換する。
 * 各エントリは monitor.js の POST /api/monitor に直接 POST できる形。
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.keyword
 * @param {string[]} opts.discoveredUrls
 * @param {'sneaker'|'standard'} [opts.mode='standard']
 * @returns {Array<{ keyword: string, userId: string, url: string, mode: string, itemId: string, sourceId: string }>}
 */
/**
 * 発見した URL を monitor 登録用のエントリ配列に変換する。
 * canonical エンジン統合版。
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.keyword
 * @param {string[]} opts.discoveredUrls
 * @param {'sneaker'|'standard'} [opts.mode='standard']
 * @param {object} [opts.product] - buildProductEntry の返り値
 */
export function buildMonitorEntries({ userId, keyword, discoveredUrls, mode = 'standard', product = null }) {
  const kwHash      = Buffer.from(keyword).toString('base64url').slice(0, 12);
  const canonicalName = product?.canonicalName || keyword;
  const category    = product?.category || 'standard';
  const resolvedMode = product?.mode || mode;

  if (discoveredUrls.length === 0) {
    // URL が見つからなくてもキーワード見守りエントリを1件返す
    return [{
      keyword,
      canonicalName,
      userId,
      url: '',
      mode: resolvedMode,
      category,
      itemId:   `kwitem_${kwHash}`,
      sourceId: `kwsrc_${kwHash}`,
    }];
  }

  return discoveredUrls.map((url, i) => {
    const urlHash = Buffer.from(url).toString('base64url').slice(0, 12);
    return {
      keyword,
      canonicalName,
      userId,
      url,
      mode: resolvedMode,
      category,
      itemId:   `urlitem_${urlHash}`,
      sourceId: `kwsrc_${kwHash}_${i}`,
    };
  });
}
