/**
 * SERP 用エントリ組み立て・poll サイズランク。キーワード錨の PDP 判定は serp-v5-pipeline の serpV5AnchorProgramMatch。
 */

import { extractModelNumbers, extractSizeFromKeyword, hasSizeInTitleUniversal } from './cross-validator.js';
import { extractColorKeywords, buildSerpPlainTextHaystack } from './color-filter.js';

/** 監視・SERP 服サイズ（アルファ6種のみ） */
const CLOTHING = ['XXL', 'XL', 'L', 'M', 'S', 'XS'];

/**
 * colorKeywords で付いた cm が fail-close と整合するときだけ靴 sizeInfo にする。
 * @param {string} s
 * @returns {{ type: 'shoe', raw: string }|null}
 */
function strictShoeSizeInfoFromToken(s) {
  const t = String(s ?? '').trim();
  if (/[-〜~\u2013\u2014]/.test(t) || /約|前後/.test(t)) return null;
  const m = t.match(/^(\d{1,2}(?:\.\d)?)\s*cm$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 14 || n > 35) return null;
  const canon = Math.round(n * 10) / 10;
  const raw = canon % 1 === 0 ? String(Math.trunc(canon)) : canon.toFixed(1);
  return { type: 'shoe', raw };
}

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
    const sho = strictShoeSizeInfoFromToken(s);
    if (sho) {
      push(sho);
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

// ── poll 用: マイサイズ A/B/C（厳格: 本文にマイサイズが無ければ在庫フラグで繰り上げない）────────

/** user-settings 保存形と整合（長い表記を先に試す） */
const POLL_CLOTHING_FOR_SIGNAL = ['XXL', 'XL', 'L', 'M', 'S', 'XS'];

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
  const shoeN =
    typeof settings.shoeCm === 'number' && Number.isFinite(settings.shoeCm)
      ? settings.shoeCm
      : settings.shoeCm != null && settings.shoeCm !== ''
        ? Number(settings.shoeCm)
        : NaN;
  if (Number.isFinite(shoeN)) {
    const r = Math.round(shoeN * 10) / 10;
    if (r < 20.0 || r > 35.0) return null;
    const raw = Number.isInteger(r) ? String(r) : r.toFixed(1);
    return { type: 'shoe', raw };
  }
  if (typeof settings.clothing === 'string' && settings.clothing.trim()) {
    return { type: 'clothing', raw: settings.clothing.trim().toUpperCase() };
  }
  const numN =
    typeof settings.numeric === 'number' && Number.isFinite(settings.numeric)
      ? settings.numeric
      : settings.numeric != null && settings.numeric !== ''
        ? Number(settings.numeric)
        : NaN;
  if (Number.isFinite(numN)) {
    const i = Math.round(numN);
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
  // 検索結果配列に null/欠損が混じると buildSerpPlainTextHaystack が落ちる（Vercel 500）
  if (!item || typeof item !== 'object') return 'C';
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
    if (item && typeof item === 'object') item.sizeRank = rank;
  }
  return decorated.map(d => d.item);
}
