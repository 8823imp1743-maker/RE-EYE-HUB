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

// ── poll 用: マイサイズ A/B/C（厳格: 本文にマイサイズが無ければ在庫フラグで繰り上げない）────────

/** user-settings 保存形と整合（長い表記を先に試す） */
const POLL_CLOTHING_FOR_SIGNAL = ['4XL', '3XL', '2XL', 'XXL', 'XL', 'XS', 'XXS', 'L', 'M', 'S'];

const SHOE_CM_IN_TEXT = /(\d{2}(?:\.\d)?)\s*cm/gi;

/**
 * Redis のユーザー設定オブジェクトから、poll が使う sizeInfo を1つ選ぶ。
 * 優先: shoeCm → clothing → numeric（user-settings.js の意図に合わせる）
 *
 * @param {{ shoeCm?: number|null, clothing?: string|null, numeric?: number|null }} settings
 * @returns {{ type: 'shoe'|'clothing'|'numeric', raw: string }|null}
 */
export function pickPollMySizeInfoFromSettings(settings) {
  if (!settings || typeof settings !== 'object') return null;
  if (typeof settings.shoeCm === 'number' && Number.isFinite(settings.shoeCm)) {
    const r = Math.round(settings.shoeCm * 10) / 10;
    if (r < 20.0 || r > 35.0) return null;
    const raw = Number.isInteger(r) ? String(r) : r.toFixed(1);
    return { type: 'shoe', raw };
  }
  if (typeof settings.clothing === 'string' && settings.clothing.trim()) {
    return { type: 'clothing', raw: settings.clothing.trim().toUpperCase() };
  }
  if (typeof settings.numeric === 'number' && Number.isFinite(settings.numeric)) {
    const i = Math.round(settings.numeric);
    if (i < 20 || i > 60) return null;
    return { type: 'numeric', raw: String(i) };
  }
  return null;
}

function hayHasAnyShoeCmSignal(hay) {
  if (!hay) return false;
  const t = String(hay);
  let m;
  SHOE_CM_IN_TEXT.lastIndex = 0;
  while ((m = SHOE_CM_IN_TEXT.exec(t)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v) && v >= 20.0 && v <= 35.0) return true;
  }
  return false;
}

function hayHasAnyClothingSizeSignal(hay) {
  if (!hay) return false;
  for (const raw of POLL_CLOTHING_FOR_SIGNAL) {
    if (hasSizeInTitleUniversal(hay, { type: 'clothing', raw })) return true;
  }
  return false;
}

/**
 * poll 用サイズランク（厳格）。
 * - A: 本文（SERP と同じ haystack）にマイサイズが現れる
 * - B: A ではないが、同一軸で「他サイズの痕跡」が本文にある（靴=20〜35cm、服=許容トークン）
 * - C: 上記以外（本文にマイサイズも他サイズの根拠も弱い。在庫ありでも繰り上げない）
 *
 * @param {object} item 楽天・Yahoo 正規化アイテム
 * @param {{ shoeCm?: number|null, clothing?: string|null, numeric?: number|null }} settings
 * @returns {'A'|'B'|'C'|null}  設定が無いとき null（ソート・付与しない）
 */
export function computePollSizeRank(item, settings) {
  const sizeInfo = pickPollMySizeInfoFromSettings(settings);
  if (!sizeInfo) return null;
  const hay = buildSerpPlainTextHaystack(item);
  if (hasSizeInTitleUniversal(hay, sizeInfo)) return 'A';
  if (sizeInfo.type === 'shoe') {
    return hayHasAnyShoeCmSignal(hay) ? 'B' : 'C';
  }
  if (sizeInfo.type === 'clothing') {
    return hayHasAnyClothingSizeSignal(hay) ? 'B' : 'C';
  }
  return 'C';
}

const POLL_RANK_ORDER = { A: 0, B: 1, C: 2 };

/**
 * 各 item に sizeRank を付与し、A→B→C の安定ソートを返す。
 * マイサイズ未設定のときは配列も要素も変更しない。
 *
 * @param {object[]} items
 * @param {{ shoeCm?: number|null, clothing?: string|null, numeric?: number|null }|null} settings
 * @returns {object[]}
 */
export function stampPollSizeRankAndSort(items, settings) {
  if (!items?.length) return items || [];
  if (!pickPollMySizeInfoFromSettings(settings)) return items;

  const decorated = items.map((item, idx) => ({
    item,
    idx,
    rank: computePollSizeRank(item, settings),
  }));
  decorated.sort((a, b) => {
    const oa = POLL_RANK_ORDER[a.rank];
    const ob = POLL_RANK_ORDER[b.rank];
    if (oa !== ob) return oa - ob;
    return a.idx - b.idx;
  });
  for (const { item, rank } of decorated) {
    item.sizeRank = rank;
  }
  return decorated.map(d => d.item);
}
