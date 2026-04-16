/**
 * POST /api/search
 * ブランド名正規化 + 楽天・Yahoo横断リアルタイム在庫検索
 *
 * リクエスト Body:
 *   { keyword: string, userId?: string }
 *
 * レスポンス（見つかった場合）:
 *   { found: true, items: Item[], normalizedKeyword: string, errors: string[] }
 *
 * レスポンス（見つからない場合）:
 *   { found: false, items: [], normalizedKeyword: string, errors: string[] }
 */

import { searchAll } from '../lib/shop-adapters/index.js';
import { getSearchKeywords, normalizeBrand, isBrandOnly } from '../lib/brand-normalizer.js';
import { getUserSizeKeyword } from '../lib/user-size.js';
import { filterByColor, expandColorQuery } from '../lib/color-filter.js';
import { searchGoogleShopping } from '../lib/google-shopping.js';
import { generateVibeQueries } from '../lib/ai-extractor.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { keyword, userId, forChild } = req.body || {};
  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    return res.status(400).json({ error: 'keyword is required' });
  }

  // ── サイズ自動注入（userId があれば Redis から設定を読んでキーワードに付加）──
  const baseKeyword = keyword.trim();
  const trimmed = userId
    ? await getUserSizeKeyword(userId, baseKeyword, !!forChild)
    : baseKeyword;
  if (trimmed !== baseKeyword) {
    console.log(`[search] サイズ注入: "${baseKeyword}" → "${trimmed}"`);
  }

  // ── ブランド名のみ検索を遮断 ──────────────────────────────
  // [ブランド名] 単体は「商品が特定されていない」として結果を返さない
  console.log(`[search] keyword="${trimmed}" isBrandOnly=${isBrandOnly(trimmed)}`);
  if (isBrandOnly(trimmed)) {
    console.log(`[search] BLOCKED: ブランド名のみ → brandOnly=true を返す`);
    return res.status(200).json({
      found:             false,
      brandOnly:         true,
      items:             [],
      normalizedKeyword: trimmed,
      errors:            [],
    });
  }

  const searchKeywords = getSearchKeywords(trimmed);
  const normalizedKeyword = normalizeBrand(trimmed);

  // 色同義語展開（水色 → 水色 ライトブルー celeste）
  const expandedKeyword = expandColorQuery(trimmed);

  // Vibe クエリ生成（Gemini が「監督の検索クエリ」を生成）
  const vibeQueriesResult = await generateVibeQueries(trimmed, 1).catch(() => [trimmed]);
  const vibeQuery = vibeQueriesResult[0] || expandedKeyword;

  // 楽天・Yahoo + Google Shopping を並列で叩く
  const [shopResults, googleData] = await Promise.allSettled([
    Promise.allSettled(
      searchKeywords.map(kw => searchAll(kw, { maxResults: 20, inStockOnly: false }))
    ),
    searchGoogleShopping(vibeQuery, null),
  ]);

  const allItems = [];
  const errors = [];

  // 楽天・Yahoo 結果をマージ
  if (shopResults.status === 'fulfilled') {
    shopResults.value.forEach(r => {
      if (r.status === 'fulfilled') {
        allItems.push(...r.value.items);
        errors.push(...r.value.errors);
      } else {
        errors.push(r.reason?.message || 'search error');
      }
    });
  }

  // Google Shopping 結果をマージ
  if (googleData.status === 'fulfilled') {
    const gItems = googleData.value?.items || [];
    allItems.push(...gItems);
    console.log(`[search] Google Shopping: ${gItems.length}件追加`);
  }

  // 重複排除（同一ショップの同一アイテムID）
  const seen = new Set();
  const dedupedItems = allItems.filter(item => {
    const key = `${item.sourceId}:${item.itemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── 監督専用：中古・オークション完全抹殺フィルター ──────────────────────
  const FORBIDDEN_SOURCES = ['yahoo_auction', 'mercari', 'fril', 'paypay_fleamarket'];
  const FORBIDDEN_KEYWORDS = ['中古', 'used', '古着', 'オークション', 'ヤフオク', '美品', '箱なし']
    .map(s => String(s).toLowerCase());

  const cleanItems = dedupedItems.filter(item => {
    // 1. 出所（ソース）がオークション系なら即廃棄
    if (FORBIDDEN_SOURCES.includes(item.sourceId)) return false;

    // 2. タイトルに「中古」などのゴミワードが含まれていたら即廃棄
    const title = String(item.title || '').toLowerCase();
    if (FORBIDDEN_KEYWORDS.some(word => title.includes(word))) return false;

    return true;
  });

  // ── さらに「サイズ不一致」もここで厳格に弾く ──────────────────────────
  // search は userId があれば getUserSizeKeyword() によりサイズが keyword に注入される。
  // その注入文字列から靴サイズを推定し、別サイズが明確に混在する商品を落とす。
  const inferredShoeSize = (() => {
    const s = String(trimmed);
    // 品番 (例: CW2288) の "22" を誤爆しないよう、区切り文字を要求する
    const re = /(?:^|[\s　/|:：()\[\]【】\-])((?:2[0-9]|3[0-2])(?:\.\d)?)(?:\s*cm)?(?!\d)/gi;
    const candidates = [...s.matchAll(re)].map(m => m[1]).filter(Boolean);
    if (candidates.length === 0) return '';
    // "26.5" のような小数表記を優先（靴サイズで出やすい）
    const withDot = candidates.find(c => c.includes('.'));
    return withDot || candidates[0];
  })();

  const sizeMatchItems = cleanItems.filter(item => {
    if (!inferredShoeSize) return true;
    const title = String(item.title || '');

    // 他サイズ表記（例: 27.5 / 28 / 29）を含み、かつ目的サイズを含まないなら廃棄
    const otherSizes = [
      '22', '22.5', '23', '23.5', '24', '24.5',
      '25', '25.5', '26', '26.5', '27', '27.5',
      '28', '28.5', '29', '29.5', '30'
    ].filter(s => s !== inferredShoeSize);

    const hasTarget = new RegExp(`(^|[^\\d.])${inferredShoeSize}($|[^\\d.])`).test(title);
    const hasOther = otherSizes.some(s => new RegExp(`(^|[^\\d.])${s}($|[^\\d.])`).test(title));

    if (!hasTarget && hasOther) return false;
    return true;
  });

  // ── 関連性フィルタリング ──────────────────────────────────
  // キーワードのトークンがタイトルに含まれるアイテムのみ通す
  // ブランド名だけのノイズ排除: 50%以上のトークン一致を要求
  function calcRelevance(title, keyword) {
    if (!title || !keyword) return 0;
    const norm = s => s.toLowerCase()
      .replace(/[【】「」（）()\-・、。！？\s　]+/g, ' ').trim();
    const haystack = norm(title);
    const tokens = norm(keyword).split(' ').filter(t => t.length >= 1);
    if (tokens.length === 0) return 1; // トークンなし = スコア最大（スキップしない）
    const hits = tokens.filter(t => haystack.includes(t)).length;
    return hits / tokens.length;
  }

  const RELEVANCE_MIN = 0.3; // 日英混在タイトル対応: 30%以上のトークン一致で通過
  const relevantItems = sizeMatchItems.filter(item => {
    const title = item.title || '';
    return calcRelevance(title, trimmed) >= RELEVANCE_MIN ||
           calcRelevance(title, normalizedKeyword) >= RELEVANCE_MIN;
  });

  // ── 色フィルタリング ─────────────────────────────────────────────────────
  // キーワードに「ピンク」「white」等の色が含まれる場合、
  // その色がタイトルに存在しない商品は1件残らず廃棄する。
  // 「デニム」が一致していても「ピンク」がなければノイズ。
  const colorFiltered = filterByColor(relevantItems, trimmed);

  // 在庫あり優先でソート → 同じ在庫状態は価格順
  colorFiltered.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return (a.price || 0) - (b.price || 0);
  });

  return res.status(200).json({
    found: colorFiltered.length > 0,
    items: colorFiltered,
    normalizedKeyword,
    errors,
  });
}
