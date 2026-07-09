/**
 * 商品名キーワードマッチ（ルールベース・AI 不使用）
 */

import { extractColorKeywords, buildColorMatchBlob } from './color-filter.js';

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

function isNumericToken(tok) {
  return /^\d+(?:\.\d+)?$/.test(String(tok || '').trim());
}

/** 数字トークンがタイトル内で独立語として存在するか（前後が数字・年でない） */
function titleHasStandaloneNumeric(text, numTok) {
  const escaped = String(numTok).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![0-9])${escaped}(?![0-9年])`, 'i');
  return re.test(String(text || ''));
}

function compactSpaces(s) {
  return String(s || '').replace(/\s+/g, '');
}

/** 文字トークン: 通常部分一致 + blob 側スペース除去版での一致（エアマックス ≈ エア マックス） */
function textTokenMatchesBlob(tok, blob, blobCompact) {
  const t = String(tok || '').toLowerCase().trim();
  if (!t) return false;
  const tCompact = compactSpaces(t);
  return blob.includes(t) || (tCompact.length >= 2 && blobCompact.includes(tCompact));
}

function brandTokenMatchesBlob(tok, blob, blobCompact) {
  if (isNumericToken(tok)) return titleHasStandaloneNumeric(blob, tok);
  return textTokenMatchesBlob(tok, blob, blobCompact);
}

/**
 * キーワードとタイトルテキストの関連性（ルールベース・全ジャンル共通）
 * - 文字トークン: 部分一致（従来どおり）
 * - 数字トークン: 独立語としての存在を要求（例: 型番「90」が「190」内に誤ヒットしない）
 *
 * @param {string} text 比較対象テキスト（小文字化済み推奨）
 * @param {string} keyword ユーザーキーワード（サイズ・色含み可）
 * @param {string} [normalizedBrand] normalizeBrand の結果
 * @returns {boolean}
 */
export function calcRelevance(text, keyword, normalizedBrand) {
  const blob = String(text || '').toLowerCase();
  if (!blob.trim()) return false;
  const blobCompact = compactSpaces(blob);

  let core = stripColorWordsFromKeyword(keyword);
  core = stripSizeTokens(core);
  const brandCore = normalizedBrand ? stripColorWordsFromKeyword(normalizedBrand) : '';

  if (core.length >= 2 && blob.includes(core.toLowerCase())) return true;
  if (brandCore.length >= 2 && blob.includes(brandCore.toLowerCase())) return true;

  const rawTokens = core.split(/[\s　]+/).filter(Boolean);
  const numericTokens = rawTokens.filter(isNumericToken);
  const textTokens = rawTokens.filter((t) => !isNumericToken(t) && t.length >= 2);

  if (numericTokens.length === 0 && textTokens.length === 0) {
    const fallback = keyword.toLowerCase().replace(/\s+/g, ' ').trim();
    if (fallback.length >= 2 && blob.includes(fallback)) return true;
    return false;
  }

  for (const numTok of numericTokens) {
    if (!titleHasStandaloneNumeric(blob, numTok)) return false;
  }

  if (textTokens.length > 0) {
    if (textTokens.some((tok) => textTokenMatchesBlob(tok, blob, blobCompact))) return true;
  } else if (numericTokens.length > 0) {
    return true;
  }

  if (normalizedBrand) {
    const btoks = normalizedBrand.split(/[\s　]+/).filter((t) => t.length >= 2);
    if (btoks.some((t) => brandTokenMatchesBlob(t, blob, blobCompact))) return true;
  }

  return false;
}

/**
 * 楽天・Yahoo の商品が検索キーワードと「商品名として」一致するか（寛容）
 *
 * ⚠️ 互換レイヤ — 構造化データ（sku / size / color）が揃っている entry では
 *   serpItemMatchesRule() がこの関数を呼び出さない。
 *   この関数は sku/canonical_id を持たない旧 entry を救済するためにのみ使用する。
 *   新規登録の entry ではこの関数に依存しないこと。
 *
 * - 色指定は color-filter 側で別処理
 * - calcRelevance() で文字トークン・数字トークンを分離判定
 *
 * @param {{ title?: string }} item 楽天・Yahoo 正規化アイテム（description 等あればマッチに利用）
 * @param {string} keyword ユーザーキーワード（サイズ・色含み可）
 * @param {string} [normalizedBrand] normalizeBrand の結果
 */
export function matchesProductKeyword(item, keyword, normalizedBrand) {
  const blob = buildColorMatchBlob(item);
  const text = blob || (item.title || '').toLowerCase();
  return calcRelevance(text, keyword, normalizedBrand);
}
