/**
 * 商品名キーワードマッチ（ルールベース・AI 不使用）
 */

import { extractColorKeywords } from './color-filter.js';

/**
 * キーワードから色語を除いた「商品名コア」文字列を返す（空白正規化）
 * @param {string} keyword
 */
export function stripColorWordsFromKeyword(keyword) {
  if (!keyword) return '';
  let s = keyword;
  const colors = extractColorKeywords(keyword);
  for (const c of colors) {
    s = s.split(c).join(' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 靴サイズ cm などを除いた簡易コア（商品名寄り）
 */
export function stripSizeTokens(keyword) {
  if (!keyword) return '';
  return String(keyword)
    .replace(/[0-9]{2}(\.[0-9])?\s*cm/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 楽天・Yahoo の商品が検索キーワードと「商品名として」一致するか（寛容）
 * - 色指定は color-filter 側で別処理
 * - コア語のいずれかがタイトルに含まれれば通過、またはタイトルがコア全体を含む
 *
 * @param {{ title?: string }} item
 * @param {string} keyword ユーザーキーワード（サイズ・色含み可）
 * @param {string} [normalizedBrand] normalizeBrand の結果
 */
export function matchesProductKeyword(item, keyword, normalizedBrand) {
  const title = (item.title || '').toLowerCase();
  if (!title) return false;

  let core = stripColorWordsFromKeyword(keyword);
  core = stripSizeTokens(core);
  const brandCore = normalizedBrand ? stripColorWordsFromKeyword(normalizedBrand) : '';

  if (core.length >= 2 && title.includes(core.toLowerCase())) return true;
  if (brandCore.length >= 2 && title.includes(brandCore.toLowerCase())) return true;

  const tokens = core.split(/[\s　]+/).filter(t => t.length >= 2);
  if (tokens.length === 0) {
    const fallback = keyword.toLowerCase().replace(/\s+/g, ' ').trim();
    if (fallback.length >= 2 && title.includes(fallback)) return true;
    return true;
  }
  const hitCount = tokens.filter(tok => title.includes(tok.toLowerCase())).length;
  if (hitCount >= 1) return true;

  if (normalizedBrand) {
    const btoks = normalizedBrand.split(/[\s　]+/).filter(t => t.length >= 2);
    if (btoks.some(t => title.includes(t.toLowerCase()))) return true;
  }

  return false;
}
