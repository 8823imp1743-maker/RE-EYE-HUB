/**
 * POST /api/search
 * 楽天・Yahoo 横断検索（ルールベース・Gemini 不使用）
 */

import { createHash } from 'crypto';
import { searchAllCached } from '../lib/shop-search-cache.js';
import { getSearchKeywords, normalizeBrand, isBrandOnly } from '../lib/brand-normalizer.js';
import { getUserSizeKeyword } from '../lib/user-size.js';
import { filterByColor, extractColorKeywords } from '../lib/color-filter.js';
import { matchesProductKeyword } from '../lib/keyword-match.js';
import { getRedis } from '../lib/redis.js';

const SEARCH_FULL_CACHE_TTL_SEC = 180;

function fullSearchCacheKey(trimmed, userId, forChild) {
  const payload = `${trimmed}\0${userId || ''}\0${forChild ? '1' : '0'}`;
  return `searchapi:v2:${createHash('sha256').update(payload).digest('hex').slice(0, 40)}`;
}

async function tryReadFullSearchCache(key) {
  try {
    const r = getRedis();
    const raw = await r.get(key);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn('[search] cache read skip:', e.message);
    return null;
  }
}

async function tryWriteFullSearchCache(key, payload) {
  try {
    const r = getRedis();
    await r.set(key, JSON.stringify(payload), { ex: SEARCH_FULL_CACHE_TTL_SEC });
  } catch (e) {
    console.warn('[search] cache write skip:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { keyword, userId, forChild } = req.body || {};
  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    return res.status(400).json({ error: 'keyword is required' });
  }

  const baseKeyword = keyword.trim();
  const trimmed = userId
    ? await getUserSizeKeyword(userId, baseKeyword, !!forChild)
    : baseKeyword;
  if (trimmed !== baseKeyword) {
    console.log(`[search] サイズ注入: "${baseKeyword}" → "${trimmed}"`);
  }

  const colorKeywords = extractColorKeywords(trimmed);
  console.log(
    `[search] keyword="${trimmed}" color条件=${colorKeywords.length ? colorKeywords.join(',') : '(なし)'} isBrandOnly=${isBrandOnly(trimmed)}`
  );

  if (isBrandOnly(trimmed)) {
    return res.status(200).json({
      found:             false,
      brandOnly:         true,
      items:             [],
      normalizedKeyword: trimmed,
      errors:            [],
      debug:             {
        trimmed,
        searchKeywordsTried: [],
        colorKeywords,
        matchMode:           'brand_only_blocked',
      },
    });
  }

  const cacheKey = fullSearchCacheKey(trimmed, userId, forChild);
  const cached = await tryReadFullSearchCache(cacheKey);
  if (cached) {
    console.log('[search] full-response cache HIT');
    return res.status(200).json(cached);
  }

  const searchKeywords = getSearchKeywords(trimmed);
  const normalizedKeyword = normalizeBrand(trimmed);
  const kwList = searchKeywords.length ? searchKeywords : [trimmed];

  kwList.forEach(kw => {
    console.log(`[search] 楽天・Yahoo 叩くキーワード: "${kw}"`);
  });

  const shopResults = await Promise.allSettled(
    kwList.map(kw =>
      searchAllCached(kw, { maxResults: 20, inStockOnly: false, cacheTtlSec: SEARCH_FULL_CACHE_TTL_SEC })
    )
  );

  const allItems = [];
  const errors = [];

  shopResults.forEach(r => {
    if (r.status === 'fulfilled') {
      allItems.push(...r.value.items);
      errors.push(...r.value.errors);
    } else {
      errors.push(r.reason?.message || 'search error');
    }
  });

  const seen = new Set();
  const dedupedItems = allItems.filter(item => {
    const key = `${item.sourceId}:${item.itemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const FORBIDDEN_SOURCES = ['yahoo_auction', 'mercari', 'fril', 'paypay_fleamarket'];
  const FORBIDDEN_KEYWORDS = ['中古', 'used', '古着', 'オークション', 'ヤフオク', '美品', '箱なし']
    .map(s => String(s).toLowerCase());

  const cleanItems = dedupedItems.filter(item => {
    if (FORBIDDEN_SOURCES.includes(item.sourceId)) return false;
    const title = String(item.title || '').toLowerCase();
    if (FORBIDDEN_KEYWORDS.some(word => title.includes(word))) return false;
    return true;
  });

  const inferredShoeSize = (() => {
    const s = String(trimmed);
    const re = /(?:^|[\s　/|:：()\[\]【】\-])((?:2[0-9]|3[0-2])(?:\.\d)?)(?:\s*cm)?(?!\d)/gi;
    const candidates = [...s.matchAll(re)].map(m => m[1]).filter(Boolean);
    if (candidates.length === 0) return '';
    const withDot = candidates.find(c => c.includes('.'));
    return withDot || candidates[0];
  })();

  const sizeMatchItems = cleanItems.filter(item => {
    if (!inferredShoeSize) return true;
    const title = String(item.title || '');
    const otherSizes = [
      '22', '22.5', '23', '23.5', '24', '24.5',
      '25', '25.5', '26', '26.5', '27', '27.5',
      '28', '28.5', '29', '29.5', '30',
    ].filter(s => s !== inferredShoeSize);
    const hasTarget = new RegExp(`(^|[^\\d.])${inferredShoeSize}($|[^\\d.])`).test(title);
    const hasOther = otherSizes.some(s => new RegExp(`(^|[^\\d.])${s}($|[^\\d.])`).test(title));
    if (!hasTarget && hasOther) return false;
    return true;
  });

  const nameMatched = sizeMatchItems.filter(item =>
    matchesProductKeyword(item, trimmed, normalizedKeyword)
  );

  const colorFiltered = filterByColor(nameMatched, trimmed);

  colorFiltered.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return (a.price || 0) - (b.price || 0);
  });

  const out = {
    found:             colorFiltered.length > 0,
    items:             colorFiltered,
    normalizedKeyword,
    errors,
    sourceNote:        'rakuten_yahoo_rule_based',
    debug:             {
      trimmed,
      searchKeywordsTried: kwList,
      colorKeywords,
      colorFilterStrict:   colorKeywords.length > 0,
    },
  };

  await tryWriteFullSearchCache(cacheKey, out);
  return res.status(200).json(out);
}
