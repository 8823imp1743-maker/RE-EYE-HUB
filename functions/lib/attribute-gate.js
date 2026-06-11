/**
 * attribute-gate — 通知直前の3軸一致（model / color / size）
 * 憲法: docs/RE-EYE-HUB-PRODUCT-CONSTITUTION.md
 * 在庫ありより属性一致を優先。不一致は attribute_gate_skip。
 */

import { extractModelNumbers, extractSizeFromKeyword, hasSizeInTitleUniversal } from './cross-validator.js';
import {
  buildSerpPlainTextHaystack,
  extractColorKeywords,
  validateColorMatchForItem,
} from './color-filter.js';
import { collectRequiredSizeInfos } from './serp-item-rule.js';

const CLOTHING_SIZES = new Set(['XS', 'S', 'M', 'L', 'XL', 'XXL']);

function normalizeCm(v) {
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function extractCmTokens(hay) {
  if (!hay) return [];
  const matches = [...String(hay).matchAll(/(?<!\d)(\d{2}(?:\.\d)?)(?!\d)\s*(cm|㎝)/g)];
  return matches.map((m) => Number(m[1])).filter(Number.isFinite);
}

function parseCmRangesFromHay(hay) {
  if (!hay) return [];
  const s = String(hay);
  const ranges = [];
  const seen = new Set();
  const patterns = [
    /(\d{2}(?:\.\d)?)\s*cm\s*[-～〜]\s*(\d{2}(?:\.\d)?)\s*cm/gi,
    /(\d{2}(?:\.\d)?)\s*[-～〜]\s*(\d{2}(?:\.\d)?)\s*cm/gi,
    /(\d{2}(?:\.\d)?)\s*cm\s*[-～〜]\s*(\d{2}(?:\.\d)?)(?!\d)/gi,
  ];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      const a = normalizeCm(m[1]);
      const b = normalizeCm(m[2]);
      if (a === null || b === null) continue;
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      const key = `${min}-${max}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ranges.push({ min, max });
    }
  }
  return ranges;
}

function computeExactCmMatch(hay, targets) {
  const tokens = extractCmTokens(hay);
  return (targets || []).some((t) => {
    const nt = normalizeCm(t);
    return nt !== null && tokens.some((c) => normalizeCm(c) === nt);
  });
}

/** 靴: 単一 cm またはレンジ内（±0.5cm） */
export function listingSupportsTargetCm(hay, targets) {
  if (!hay || !Array.isArray(targets) || !targets.length) return true;
  if (computeExactCmMatch(hay, targets)) return true;
  const ranges = parseCmRangesFromHay(hay);
  if (!ranges.length) return false;
  return targets.some((t) => {
    const nt = normalizeCm(t);
    if (nt === null) return false;
    return ranges.some((r) => nt >= r.min - 0.5 && nt <= r.max + 0.5);
  });
}

/**
 * 登録時・通知時に使う監視条件の正規化
 * @param {{ keyword?: string, modelNumbers?: string[], colorKeywords?: string[], targetAttributes?: object }} entry
 * @param {{ size?: string }} [extras]
 */
export function buildTargetAttributesFromEntry(entry, extras = {}) {
  const keyword = String(entry?.keyword || '').trim();
  const models = [
    ...(entry?.modelNumbers || []),
    ...extractModelNumbers(keyword),
  ].filter((v, i, a) => a.indexOf(v) === i);
  const colors = [
    ...(entry?.colorKeywords || []),
    ...extractColorKeywords(keyword),
  ].filter((v, i, a) => a.indexOf(v) === i);

  let sizeInfo = resolveRegisteredSizeInfo(keyword, extras);
  const sizeInfos = collectRequiredSizeInfos(
    { colorKeywords: colors, modelNumbers: models, keyword },
    keyword
  );
  if (!sizeInfo && sizeInfos.length) sizeInfo = sizeInfos[0];
  if (!sizeInfo && entry?.targetAttributes?.size) {
    sizeInfo = sizeInfoFromRaw(entry.targetAttributes.size, entry.targetAttributes.sizeType);
  }

  return {
    model: models[0] || null,
    models,
    color: colors[0] || null,
    colors,
    size: sizeInfo?.raw || null,
    sizeType: sizeInfo?.type || null,
    sizeInfos,
    keyword,
  };
}

function sizeInfoFromRaw(raw, typeHint) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (typeHint === 'clothing' || CLOTHING_SIZES.has(s.toUpperCase())) {
    const u = s.toUpperCase();
    if (CLOTHING_SIZES.has(u)) return { type: 'clothing', raw: u };
  }
  const cm = s.match(/^(\d{2}(?:\.\d)?)/);
  if (cm) {
    const n = parseFloat(cm[1]);
    if (Number.isFinite(n) && n >= 10 && n <= 35) {
      const canon = Math.round(n * 10) / 10;
      const rawStr = canon % 1 === 0 ? String(Math.trunc(canon)) : canon.toFixed(1);
      return { type: 'shoe', raw: rawStr };
    }
  }
  return null;
}

/** @param {string} keyword @param {{ size?: string }} [body] */
export function resolveRegisteredSizeInfo(keyword, body = {}) {
  const fromKw = extractSizeFromKeyword(keyword);
  if (fromKw) return fromKw;
  return sizeInfoFromRaw(body?.size, body?.sizeType);
}

function itemMatchesSingleSize(hay, sizeInfo) {
  if (!sizeInfo?.type) return false;
  if (sizeInfo.type === 'shoe') {
    if (hasSizeInTitleUniversal(hay, sizeInfo)) return true;
    return listingSupportsTargetCm(hay, [sizeInfo.raw]);
  }
  return hasSizeInTitleUniversal(hay, sizeInfo);
}

function itemMatchesModel(hay, models) {
  if (!models?.length) return false;
  const t = String(hay || '').toUpperCase();
  return models.some((m) => t.includes(String(m).toUpperCase()));
}

function itemMatchesColors(item, colors, keyword) {
  if (!colors?.length) return { ok: false, detail: 'color_missing' };
  const pseudoKw = `${keyword || ''} ${colors.join(' ')}`.trim();
  if (!validateColorMatchForItem(item, pseudoKw)) {
    return { ok: false, detail: 'color_mismatch' };
  }
  return { ok: true };
}

/**
 * 通知直前の attribute-gate
 * @param {object} entry 監視 Redis エントリ相当
 * @param {object} item SERP / モール行
 * @param {{ requireAllAxes?: boolean, extras?: object }} [opts]
 * @returns {{ pass: boolean, reason: string, failedAxis?: string, detail?: string, targetAttributes?: object }}
 */
export function evaluateAttributeGate(entry, item, opts = {}) {
  const requireAll = opts.requireAllAxes !== false;
  const ta = buildTargetAttributesFromEntry(entry, opts.extras || {});
  const hay = buildSerpPlainTextHaystack(item);

  if (!ta.models.length) {
    return fail('model', 'model_missing', ta);
  }
  if (!ta.colors.length) {
    return fail('color', 'color_missing', ta);
  }
  if (!ta.sizeInfos.length && !ta.size) {
    return fail('size', 'size_missing', ta);
  }

  const sizeInfos =
    ta.sizeInfos.length > 0
      ? ta.sizeInfos
      : ta.size
        ? [sizeInfoFromRaw(ta.size, ta.sizeType)].filter(Boolean)
        : [];

  if (requireAll && !sizeInfos.length) {
    return fail('size', 'size_missing', ta);
  }

  if (!itemMatchesModel(hay, ta.models)) {
    return fail('model', 'model_mismatch', ta);
  }

  const colorRes = itemMatchesColors(item, ta.colors, ta.keyword);
  if (!colorRes.ok) {
    return fail('color', colorRes.detail, ta, colorRes.color);
  }

  for (const si of sizeInfos) {
    if (!itemMatchesSingleSize(hay, si)) {
      return fail('size', 'size_mismatch', ta);
    }
  }

  return { pass: true, reason: 'attribute_gate_pass', targetAttributes: ta };
}

function fail(axis, detail, ta, color) {
  return {
    pass: false,
    reason: 'attribute_gate_skip',
    failedAxis: axis,
    detail,
    ...(color ? { color } : {}),
    targetAttributes: ta,
  };
}

/** @param {object} gateResult evaluateAttributeGate の戻り */
export function attributeGateSkipLogPayload(gateResult, item, source) {
  return {
    source: source || 'unknown',
    reason: gateResult.reason,
    failedAxis: gateResult.failedAxis,
    detail: gateResult.detail,
    model: gateResult.targetAttributes?.model,
    color: gateResult.targetAttributes?.color,
    size: gateResult.targetAttributes?.size,
    url: String(item?.url || '').slice(0, 90),
    title: String(item?.title || '').slice(0, 60),
  };
}
