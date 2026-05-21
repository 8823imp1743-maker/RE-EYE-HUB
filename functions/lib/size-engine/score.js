/**
 * 「タイトル等から読み取った候補 cm」とターゲット群のギャップ（一覧の並び替え専用）
 *
 * @param {string} haystack
 * @param {number[]} targetCms
 * @returns {number} bonus
 */
export function haystackCmGapTierBonus(haystack, targetCms) {
  const targets = (targetCms || []).filter((n) => Number.isFinite(n));
  if (targets.length === 0) return 0;

  const found = [];
  const s = String(haystack || '');
  for (const m of s.matchAll(/(\d{2}(?:\.\d)?)\s*(?:㎝|cm)\b/gi)) {
    const q = parseFloat(m[1]);
    if (Number.isFinite(q) && q >= 14 && q <= 35) found.push(q);
  }
  if (found.length === 0) return 0;

  let best = Infinity;
  for (const f of found) {
    for (const t of targets) {
      const g = Math.abs(f - t);
      if (g < best) best = g;
    }
  }
  if (!Number.isFinite(best)) return 0;
  if (best <= 1e-6) return 120;
  if (best <= 0.5) return 100;
  if (best <= 1.0) return 80;
  return -80;
}

/**
 * @param {number|null|undefined} itemCm
 * @param {number[]} targetCms
 */
export function cmDistanceTierBonus(itemCm, targetCms) {
  const targets = (targetCms || []).filter((n) => Number.isFinite(n));
  if (targets.length === 0) return 0;
  if (itemCm == null || !Number.isFinite(Number(itemCm))) return 0;
  const ic = Number(itemCm);
  let best = Infinity;
  for (const t of targets) {
    const g = Math.abs(ic - t);
    if (g < best) best = g;
  }
  if (best <= 1e-6) return 120;
  if (best <= 0.5) return 100;
  if (best <= 1.0) return 80;
  return -80;
}

const ALPHA_RANK = new Map([
  ['XXS', 1],
  ['XS', 2],
  ['S', 3],
  ['M', 4],
  ['L', 5],
  ['XL', 6],
  ['XXL', 7],
  ['XXXL', 8],
  ['3XL', 9],
]);

/**
 * @param {string} hay
 * @param {string[]} targetLabels 例 ['M','L']
 */
export function apparelAlphaGapBonus(hay, targetLabels) {
  const h = String(hay || '');
  if (/FREE|ONESIZE|フリー|フリーサイズ/i.test(h)) {
    return { bonus: 0, freeSize: true };
  }
  let tag = '';
  const order = [...ALPHA_RANK.keys()].sort((a, b) => b.length - a.length);
  for (const sz of order) {
    const re = new RegExp(`\\b${sz.replace(/-/g, '\\-')}\\b`, 'i');
    if (re.test(h)) {
      tag = sz;
      break;
    }
  }
  if (!tag) return { bonus: 0, freeSize: false };

  const rr = ALPHA_RANK.get(tag.toUpperCase().replace(/\s+/g, ''));
  if (rr == null) return { bonus: 0, freeSize: false };

  const want = new Set(
    (targetLabels || []).map((x) => String(x || '').toUpperCase().replace(/\s+/g, ''))
  );
  if (want.has(tag.toUpperCase())) return { bonus: 100, freeSize: false };

  let near = false;
  for (const w of want) {
    const wr = ALPHA_RANK.get(w);
    if (wr != null && Math.abs(wr - rr) === 1) near = true;
  }
  if (near) return { bonus: 70, freeSize: false };
  if (want.size) return { bonus: 50, freeSize: false };
  return { bonus: 0, freeSize: false };
}
