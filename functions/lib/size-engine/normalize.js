import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferGenderFromText } from './gender.js';
import { inferKids } from './kids.js';
import { usToCm, euRoughToCm } from './convert.js';

const __dir = dirname(fileURLToPath(import.meta.url));

/** @type {Record<string, { w_to_m_cm?: number; w_to_m?: number }>} */
let BRANDS = {};
try {
  const parsed = JSON.parse(readFileSync(join(__dir, 'brand-map.json'), 'utf8'));
  BRANDS = Object.fromEntries(
    Object.entries(parsed).filter(([k]) => typeof k === 'string' && !k.startsWith('_'))
  );
} catch {
  BRANDS = {};
}

function round1(x) {
  return Math.round(Number(x) * 10) / 10;
}

/** @param {unknown} x */
export function coerceNum(x) {
  const n = parseFloat(String(x).replace(/,/g, '.').trim());
  return Number.isFinite(n) ? n : null;
}

/** @param {'women'|'men'|'unknown'} g */
export function brandWmOffsetCm(brandKey, g) {
  const bk = String(brandKey || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const bb = BRANDS[bk];
  const rawOff = bb?.w_to_m_cm ?? bb?.w_to_m;
  const off = typeof rawOff === 'number' ? rawOff : -1.5;
  if (g === 'women') return off;
  return 0;
}

/**
 * PDP・検索 — ユーザー＋キーワード複数 cm（API `multiTargetCm`）から cm リスト
 *
 * @param {{ shoeCm?: number|null; shoeSize?: unknown; childShoeSize?: unknown } | null} settings
 * @param {{ rawKeyword?: string; fallbackTargets?: number[]; multiTargetCm?: unknown[]; forChild?: boolean; brandKey?: string }} opts
 */
export function resolveCmTargetsForProfile(settings, opts = {}) {
  const out = [];

  /** @param {number} n */
  const add = (n) => {
    const r = round1(n);
    if (!Number.isFinite(r) || r < 10 || r > 80) return;
    if (!out.some((x) => Math.abs(x - r) < 1e-4)) out.push(r);
  };

  const rawKw = opts.rawKeyword != null ? String(opts.rawKeyword) : '';
  for (const m of rawKw.matchAll(/(\d{2}(?:\.\d)?)\s*(?:㎝|cm)\b/gi)) {
    const q = coerceNum(m[1]);
    if (q != null && q >= 14 && q <= 35) add(q);
  }

  if (Array.isArray(opts.multiTargetCm)) {
    for (const v of opts.multiTargetCm) {
      const q = coerceNum(v);
      if (q != null && q >= 14 && q <= 35) add(q);
    }
  }

  if (Array.isArray(opts.fallbackTargets)) {
    for (const v of opts.fallbackTargets) {
      const q = coerceNum(v);
      if (q != null && q >= 14 && q <= 35) add(q);
    }
  }

  const forChild = !!opts.forChild;
  const cfg = settings && typeof settings === 'object' ? settings : null;

  const geo = inferGenderFromText(rawKw);
  const geoForUs =
    geo === 'kids'
      ? 'men'
      : geo === 'women'
        ? 'women'
        : geo === 'men'
          ? 'men'
          : 'men';

  for (const m of rawKw.matchAll(/\bUS\s*(\d+(?:\.\d+)?)\b/gi)) {
    const us = parseFloat(m[1]);
    const cmAlt = usToCm(us, geoForUs === 'women' ? 'women' : geoForUs === 'men' ? 'men' : 'men');
    if (cmAlt != null) add(cmAlt);
  }
  for (const m of rawKw.matchAll(/\bEU\s*([\d.]+)\b/gi)) {
    const eu = parseFloat(m[1]);
    const cmEu = euRoughToCm(eu);
    if (cmEu != null) add(cmEu);
  }

  if (forChild) {
    const ch = cfg?.childShoeSize != null && cfg.childShoeSize !== '' ? coerceNum(cfg.childShoeSize) : null;
    if (ch != null && ch >= 10 && ch <= 25) add(ch);
  } else if (cfg) {
    if (typeof cfg.shoeCm === 'number' && Number.isFinite(cfg.shoeCm) && cfg.shoeCm >= 14 && cfg.shoeCm <= 35) {
      add(cfg.shoeCm);
    } else if (cfg.shoeCm != null && cfg.shoeCm !== '') {
      const cn = coerceNum(cfg.shoeCm);
      if (cn != null && cn >= 14 && cn <= 35) add(cn);
    }
    const lg = cfg.shoeSize != null && cfg.shoeSize !== '' ? coerceNum(cfg.shoeSize) : null;
    if (lg != null && lg >= 14 && lg <= 35) add(lg);
  }

  return out.slice(0, 8).sort((a, b) => a - b);
}

/**
 * @typedef {{
 * value: number;
 * unit: 'cm'|'us'|'eu'|'alpha';
 * system: string;
 * gender: 'men'|'women'|'kids'|'unknown';
 * category: 'shoe'|'apparel';
 * }} UnifiedSizeShape
 */

/**
 * 単一案に正規化（cm は JP 換算済み。**曖昧は null**。alpha は服 rank 近似）
 *
 * @param {unknown} raw
 * @param {string} [title]
 * @param {{ category?: 'shoe'|'apparel'; brandKey?: string }} [opts]
 * @returns {UnifiedSizeShape | null}
 */
export function normalizeSize(raw, title = '', opts = {}) {
  const s0 = raw != null ? String(raw).trim() : '';
  const hay = `${s0} ${title || ''}`.trim();
  if (!s0.trim() && !hay.trim()) return null;

  const geo = inferGenderFromText(hay);
  let gender = geo;
  if (inferKids(null, hay)) gender = 'kids';

  /** @type {'shoe'|'apparel'} */
  let category =
    opts.category ||
    (/シューズ|スニーカー|靴|ソール|(㎝|cm)\s|^\d{2}|\bUS\b|\bEU\b|\bサイズ\b/i.test(hay)
      ? 'shoe'
      : /\b^(XS|S|M|L|XL|XXL)$/i.test(s0.trim())
      ? 'apparel'
      : 'shoe');

  if (category === 'apparel') {
    const tk = /\b(XXS|XS|S|M|L|XL|XXL|XXXL)\b/i.exec(hay)?.[1] || /^([XSML]|XXS|XL|XXL)$/i.exec(s0)?.[1];
    if (!tk) return null;
    const rank = new Map([
      ['XXS', 1],
      ['XS', 2],
      ['S', 3],
      ['M', 4],
      ['L', 5],
      ['XL', 6],
      ['XXL', 7],
      ['XXXL', 8],
    ]);
    const v = rank.get(String(tk).toUpperCase());
    if (v == null) return null;
    return { value: v, unit: 'alpha', system: 'INTL', gender, category: 'apparel' };
  }

  const cms = s0.match(/^(\d{2}(?:\.\d)?)\s*(?:㎝|cm)?$/i) || /\b(\d{2}(?:\.\d)?)\s*(㎝|cm)\b/i.exec(hay);
  if (cms) {
    const v = coerceNum(cms[1]);
    if (v != null && v >= 14 && v <= 35) {
      return { value: round1(v), unit: 'cm', system: 'JP', gender, category: 'shoe' };
    }
  }

  const usm = /\bUS\s*(\d+(?:\.\d+)?)\b/i.exec(s0) || /\bUS\s*(\d+(?:\.\d+)?)\b/i.exec(hay);
  if (usm) {
    const u = parseFloat(usm[1]);
    const tbl =
      gender === 'women' ? 'women' : gender === 'kids' || gender === 'men' ? 'men' : 'men';

    /** @type {'men'|'women'} */
    const hint = tbl === 'women' ? 'women' : 'men';
    let cv = usToCm(u, hint);
    if (cv != null && cv >= 14 && cv <= 35)
      return { value: round1(cv), unit: 'us', system: 'US', gender, category: 'shoe' };
  }

  const eum = /\bEU\s*([\d.]+\.?)\b/i.exec(s0 + ' ' + hay);
  if (eum) {
    const euCm = euRoughToCm(parseFloat(eum[1]));
    if (euCm != null)
      return { value: euCm, unit: 'eu', system: 'EU', gender, category: 'shoe' };
  }

  const plainNum = coerceNum(s0.replace(/[^\d.]/g, '').trim()) ?? coerceNum(s0);
  if (
    plainNum != null &&
    plainNum >= 14 &&
    plainNum <= 35 &&
    /^\d{2}(\.\d)?$/.test(s0.replace(/[^\d.]/g, '').trim())
  )
    return { value: round1(plainNum), unit: 'cm', system: 'JP', gender, category: 'shoe' };

  return null;
}
