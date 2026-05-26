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
  const urls = new Set();
  let source = 'none';

  // ── Phase 1: RSS（Google News） ─────────────────────────────────────────────
  try {
    const rssResult = await scanKeyword(keyword, bypassDedup, { maxItems: 10 });
    const rssItems = Array.isArray(rssResult?.newItems) ? rssResult.newItems : [];
    for (const item of rssItems) {
      const u = item.link || item.url;
      if (u && u.startsWith('http')) urls.add(u);
      if (urls.size >= MAX_URLS_PER_KEYWORD) break;
    }
    if (urls.size > 0) source = 'rss';
  } catch (e) {
    console.warn('[scout-bridge] RSS scan failed:', e.message);
  }

  // ── Phase 2: 楽天/Yahoo API（RSS で不足時） ──────────────────────────────────
  if (urls.size < MAX_URLS_PER_KEYWORD) {
    try {
      const mallResult = await searchAllCached(keyword, {
        maxResults: 10,
        inStockOnly: false,
        skipCache: false,
      });
      const mallItems = Array.isArray(mallResult) ? mallResult : [];
      for (const item of mallItems) {
        const u = item.url || item.affiliateUrl || item.itemUrl;
        if (u && u.startsWith('http')) urls.add(u);
        if (urls.size >= MAX_URLS_PER_KEYWORD) break;
      }
      if (source === 'none' && urls.size > 0) source = 'mall';
      else if (urls.size > 0) source = 'rss+mall';
    } catch (e) {
      console.warn('[scout-bridge] Mall search failed:', e.message);
    }
  }

  const discoveredUrls = [...urls].slice(0, MAX_URLS_PER_KEYWORD);

  console.log(
    '[scout-bridge]',
    JSON.stringify({ keyword, mode, found: discoveredUrls.length, source })
  );

  return { keyword, mode, discoveredUrls, source };
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
export function buildMonitorEntries({ userId, keyword, discoveredUrls, mode = 'standard' }) {
  const kwHash = Buffer.from(keyword).toString('base64url').slice(0, 12);

  if (discoveredUrls.length === 0) {
    // URL が見つからなくてもキーワード見守りエントリを1件返す
    return [{
      keyword,
      userId,
      url: '',
      mode,
      itemId: `kwitem_${kwHash}`,
      sourceId: `kwsrc_${kwHash}`,
    }];
  }

  return discoveredUrls.map((url, i) => {
    const urlHash = Buffer.from(url).toString('base64url').slice(0, 12);
    return {
      keyword,
      userId,
      url,
      mode,
      itemId: `urlitem_${urlHash}`,
      sourceId: `kwsrc_${kwHash}_${i}`,
    };
  });
}
