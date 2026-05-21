/**
 * 靴 cm を **単一サイズのみ** のタグへ（±0.5 連動は廃止）。
 * tenth 桁で slug を安定化し、完全一致設計と一致させる。
 */

/**
 * @param {number} cm
 * @returns {number|null}
 */
export function snapCmToHalfStep(cm) {
  const n = Number(cm);
  if (!Number.isFinite(n)) return null;
  const s = Math.round(n * 2) / 2;
  if (s < 20 || s > 35) return null;
  return s;
}

/**
 * 27 → "27", 26.5 → "26_5"
 * @param {number} snappedHalf
 */
export function halfStepToBucketSlug(snappedHalf) {
  const n = Number(snappedHalf);
  if (!Number.isFinite(n)) return null;
  if (n % 1 === 0) return String(Math.round(n));
  const whole = Math.floor(n);
  return `${whole}_5`;
}

/**
 * 26.5 → "26_5", 27 → "27"（誤検出しないよう tenth のみ slug 化）
 * @param {number} canonicalTenthRounded
 */
export function tenthCmToBucketSlug(canonicalTenthRounded) {
  const n = Number(canonicalTenthRounded);
  if (!Number.isFinite(n)) return null;
  const scaled = Math.round(n * 10);
  const whole = Math.trunc(Math.floor(scaled / 10));
  const t = scaled - whole * 10;
  if (t <= 0) return String(whole);
  return `${whole}_${t}`;
}

/**
 * @param {number} listingCm （キーワード由来の単一 canonical cm）
 * @returns {string[]}
 */
export function sizeTagKeysForListingTolerance(listingCm) {
  const n = Number(listingCm);
  if (!Number.isFinite(n)) return [];
  if (n < 14 || n > 35) return [];
  const slug = tenthCmToBucketSlug(Math.round(n * 10) / 10);
  return slug ? [`size_${slug}`] : [];
}

/**
 * extractSizeFromKeyword の結果（type===shoe のとき）から listing cm を得る。
 * @param {{ type: string, raw: string }|null|undefined} sizeInfo
 */
export function listingCmFromSizeInfo(sizeInfo) {
  if (!sizeInfo || sizeInfo.type !== 'shoe') return null;
  const n = parseFloat(String(sizeInfo.raw).replace(/cm$/i, '').trim());
  if (!Number.isFinite(n)) return null;
  if (n < 14 || n > 35) return null;
  return Math.round(n * 10) / 10;
}
