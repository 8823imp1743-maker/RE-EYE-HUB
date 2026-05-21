/**
 * 在庫検索用：楽天・Yahoo へ投げるクエリを組み立てる
 * 原則: API に cm を混ぜない。品番が取れたら品番のみ。なければメーカー＋商品名（サイズ抜き）。
 */

import { getSearchKeywords, normalizeBrand } from './brand-normalizer.js';
import { extractModelNumbers } from './cross-validator.js';

const CM_RE_GLOBAL = /[0-9]{1,2}(\.[0-9])?\s*cm/gi;

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 品番候補を文字列から取り除き、連続空白を畳む（品番未使用の「名前用」検索用）
 * @param {string} input
 * @returns {string}
 */
export function stripModelCodesAndSizeForNameQuery(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  const models = extractModelNumbers(s);
  for (const m of models) {
    s = s.replace(new RegExp(escRe(m), 'gi'), ' ');
  }
  s = s.replace(CM_RE_GLOBAL, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * @param {string} inputKeyword クライアントからのキーワード（含: 従来の cm 表記。サーバでは付加しない）
 * @returns {{ kwList: string[], strategy: 'model_only'|'name_only'|'fallback_raw', modelNumbers: string[] }}
 */
export function buildMallSearchKeywordList(inputKeyword) {
  const base = String(inputKeyword || '').trim();
  if (!base) {
    return { kwList: [], strategy: 'fallback_raw', modelNumbers: [] };
  }

  const modelNumbers = extractModelNumbers(base);
  if (modelNumbers.length) {
    const kwList = [
      ...new Set(modelNumbers.flatMap((m) => getSearchKeywords(m))),
    ].filter(Boolean);
    return { kwList: kwList.length ? kwList : modelNumbers, strategy: 'model_only', modelNumbers };
  }

  const nameQ = stripModelCodesAndSizeForNameQuery(base);
  if (!nameQ) {
    return { kwList: [base], strategy: 'fallback_raw', modelNumbers: [] };
  }

  const kws = getSearchKeywords(nameQ);
  const kwList = kws && kws.length
    ? [...new Set(kws.map((k) => String(k).trim()).filter(Boolean))]
    : [nameQ];

  return { kwList, strategy: 'name_only', modelNumbers: [] };
}

/**
 * 表示・ルール用：キーワードから cm 表記を除いた文字列
 * @param {string} input
 * @returns {string}
 */
export function stripSizeCmFromDisplayKeyword(input) {
  return String(input || '')
    .replace(CM_RE_GLOBAL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export { normalizeBrand };
