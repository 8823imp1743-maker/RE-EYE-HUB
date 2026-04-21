/**
 * SERP 監視と検索 API で共通のルールベース一致判定。
 * 追加の外部 HTTP は行わず、タイトル・説明・キャッチ等を結合したテキスト上で判定する。
 */

import { extractModelNumbers, extractSizeFromKeyword, hasSizeInTitleUniversal } from './cross-validator.js';
import {
  validateColorMatchForItem,
  extractColorKeywords,
  buildSerpPlainTextHaystack,
} from './color-filter.js';
import { matchesProductKeyword } from './keyword-match.js';
import { normalizeBrand } from './brand-normalizer.js';

const CLOTHING = ['4XL', '3XL', '2XL', 'XXL', 'XL', 'L', 'M', 'S', 'XS'];

/**
 * キーワード内の cm 表記 + entry.colorKeywords の数字・服サイズを sizeInfo 化（重複除去）
 * @param {{ colorKeywords?: string[] }} entry
 * @param {string} keyword
 */
export function collectRequiredSizeInfos(entry, keyword) {
  const out = [];
  const seen = new Set();
  const push = si => {
    if (!si) return;
    const k = `${si.type}:${si.raw}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(si);
  };
  push(extractSizeFromKeyword(keyword));
  for (const ck of entry.colorKeywords || []) {
    const s = String(ck ?? '').trim();
    if (!s) continue;
    if (/^\d+(\.\d+)?(cm)?$/i.test(s)) {
      push({ type: 'shoe', raw: s.replace(/cm$/i, '') });
    } else {
      const u = s.toUpperCase();
      if (CLOTHING.includes(u)) push({ type: 'clothing', raw: u });
    }
  }
  return out;
}

/**
 * 監視 Redis エントリと同型のルール入力を、検索キーワードから組み立てる（検索 API 用）。
 * @param {string} trimmed サイズ注入後の検索語
 */
export function buildSerpRuleEntryForKeyword(trimmed) {
  return {
    keyword: trimmed,
    colorKeywords: extractColorKeywords(trimmed),
    modelNumbers: extractModelNumbers(trimmed),
  };
}

/**
 * キーワード・色・品番・サイズが商品テキストと整合するか（プログラム判定）
 * @param {{ keyword?: string, colorKeywords?: string[], modelNumbers?: string[] }} entry
 * @param {object} item 楽天・Yahoo 正規化アイテム（available = API の在庫フラグ想定）
 * @param {{ relaxSizeWhenInStock?: boolean }} [opts] 検索 API 専用: 本文にサイズが無くても API が在庫ありならサイズ条件だけ通す（靴 cm / 服 S〜XL / 数値サイズ。追加 HTTP なし）
 */
export function serpItemMatchesRule(entry, item, opts = {}) {
  const { relaxSizeWhenInStock = false } = opts;
  const keyword = entry.keyword || '';
  const normalized = normalizeBrand(keyword);
  const hay = buildSerpPlainTextHaystack(item);

  if (!validateColorMatchForItem(item, keyword)) {
    console.log(`[SERP] 色不一致スキップ: "${(item.title || '').slice(0, 45)}"`);
    return false;
  }

  const sizeInfos = collectRequiredSizeInfos(entry, keyword);
  for (const si of sizeInfos) {
    if (!hasSizeInTitleUniversal(hay, si)) {
      // 一覧 JSON にバリエーションサイズが載らない店舗がある → 検索時のみ API 在庫ありならサイズ軸は通す
      const relaxable =
        si.type === 'shoe' || si.type === 'clothing' || si.type === 'numeric';
      if (relaxSizeWhenInStock && item.available === true && relaxable) {
        console.log(
          `[SERP] サイズが本文に無いが API 在庫あり → 緩和通過（${si.type}=${si.raw}・リンク先で要確認）`
        );
        continue;
      }
      console.log(`[SERP] サイズ不一致スキップ: need ${si.type}=${si.raw} … "${(item.title || '').slice(0, 40)}"`);
      return false;
    }
  }

  const models = entry.modelNumbers || [];
  if (models.length > 0) {
    const t = hay.toUpperCase();
    const ok = models.some(m => t.includes(String(m).toUpperCase()));
    if (!ok) {
      console.log(`[SERP] 品番不一致スキップ: need [${models.join(',')}]`);
      return false;
    }
  }
  if (!matchesProductKeyword(item, keyword, normalized)) {
    console.log(`[SERP] 商品名キーワード不一致: "${(item.title || '').slice(0, 45)}"`);
    return false;
  }
  return true;
}
