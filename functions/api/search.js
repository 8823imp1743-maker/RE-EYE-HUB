/**
 * POST /api/search
 * 楽天・Yahoo 横断検索（緩和モード搭載・紫バナー確定版）
 */

import { createHash } from 'crypto';
import { searchAllCached } from '../lib/shop-search-cache.js';
import { getSearchKeywords, normalizeBrand, isBrandOnly } from '../lib/brand-normalizer.js';
import { getUserSizeKeyword } from '../lib/user-size.js';
import { extractColorKeywords } from '../lib/color-filter.js';
import { serpItemMatchesRule, buildSerpRuleEntryForKeyword } from '../lib/serp-item-rule.js';
import { getRedis } from '../lib/redis.js';
import { extractSizeFromKeyword } from '../lib/cross-validator.js';

const SEARCH_FULL_CACHE_TTL_SEC = 180;

function fullSearchCacheKey(trimmed, userId, forChild) {
  const payload = `${trimmed}\0${userId || ''}\0${forChild ? '1' : '0'}`;
  // v5: キャッシュをさらに上げて、確実に最新の緩和ロジックを適用
  return `searchapi:v5:${createHash('sha256').update(payload).digest('hex').slice(0, 40)}`;
}

// ...（中略：tryReadFullSearchCache, tryWriteFullSearchCache はそのまま）...
async function tryReadFullSearchCache(key) {
  try {
    const r = getRedis();
    const raw = await r.get(key);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return null;
  }
}

async function tryWriteFullSearchCache(key, payload) {
  try {
    const r = getRedis();
    await r.set(key, JSON.stringify(payload), { ex: SEARCH_FULL_CACHE_TTL_SEC });
  } catch (e) {
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { keyword, userId, forChild } = req.body || {};
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    const baseKeyword = keyword.trim();
    // 1. サイズ注入（26.5cmなどを自動付与）
    const trimmed = userId ? await getUserSizeKeyword(userId, baseKeyword, !!forChild) : baseKeyword;

    // 2. キャッシュ確認（v5に上げたので古い「在庫なし」は無視される）
    const cacheKey = fullSearchCacheKey(trimmed, userId, forChild);
    const cached = await tryReadFullSearchCache(cacheKey);
    if (cached) return res.status(200).json(cached);

    const searchKeywords = getSearchKeywords(trimmed);
    const normalizedKeyword = normalizeBrand(trimmed);
    const kwList = searchKeywords.length ? searchKeywords : [trimmed];

    // 3. 楽天・Yahoo API実行
    const shopResults = await Promise.allSettled(
      kwList.map(kw => searchAllCached(kw, { maxResults: 20, inStockOnly: false }))
    );

    const allItems = [];
    shopResults.forEach(r => {
      if (r.status === 'fulfilled' && r.value?.items) allItems.push(...r.value.items);
    });

    // 4. 重複排除・フィルタ
    const seen = new Set();
    const cleanItems = allItems.filter(item => {
      const key = `${item.sourceId}:${item.itemId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const title = String(item.title || '').toLowerCase();
      return !['中古', 'used', '古着', 'ヤフオク'].some(w => title.includes(w));
    });

    // 5. ★ここが核心：緩和モードの適用
    const ruleEntry = buildSerpRuleEntryForKeyword(trimmed);
    const sizeFromKw = extractSizeFromKeyword(trimmed);
    
    // サイズ条件（26.5cm等）があれば、強制的に緩和モードをON
    const serpSizeRelax = !!sizeFromKw; 

    const serpMatched = cleanItems.filter(item =>
      serpItemMatchesRule(ruleEntry, item, { relaxSizeWhenInStock: serpSizeRelax })
    );

    const out = {
      found: serpMatched.length > 0,
      items: serpMatched,
      normalizedKeyword,
      inventoryRuleNoHits: cleanItems.length > 0 && serpMatched.length === 0,
      inventorySizeVerifyAtPdp: true, // ★これを強制trueに。これで紫バナーが出る！
      debug: { trimmed, serpSizeRelax },
    };

    await tryWriteFullSearchCache(cacheKey, out);
    return res.status(200).json(out);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}