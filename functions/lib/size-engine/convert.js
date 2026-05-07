/**
 * US / EU ↔ cm の代表表（補助。**実ショップ表はブレる**ので曖昧は null）
 */
export const US_TO_CM_MEN = {
  6: 24.0,
  6.5: 24.5,
  7: 25.0,
  7.5: 25.5,
  8: 26.0,
  8.5: 26.5,
  9: 27.0,
  9.5: 27.5,
  10: 28.0,
  10.5: 28.5,
  11: 29.0,
  12: 30.0,
};
export const US_TO_CM_WOMEN = {
  6: 23.0,
  6.5: 23.5,
  7: 24.0,
  7.5: 24.5,
  8: 25.0,
  8.5: 25.5,
  9: 26.0,
  9.5: 26.5,
  10: 27.0,
  10.5: 27.5,
};

export const EU_TO_CM_ROUGH = {
  38: 24.0,
  39: 24.5,
  40: 25.0,
  41: 26.0,
  41.5: 26.25,
  42: 26.5,
  42.5: 27.0,
  43: 27.5,
};

/**
 * @param {number} us
 * @param {'men'|'women'|'unknown'} genderHint
 */
export function usToCm(us, genderHint) {
  if (!Number.isFinite(us)) return null;
  const g = genderHint === 'women' ? US_TO_CM_WOMEN : genderHint === 'men' ? US_TO_CM_MEN : US_TO_CM_MEN;
  /** @type {number|undefined} */
  const cm = /** @type {any} */ (g)[us];
  return cm != null ? Math.round(Number(cm) * 10) / 10 : null;
}

/** @param {number} eu */
export function euRoughToCm(eu) {
  if (!Number.isFinite(eu)) return null;
  const cm = eu in EU_TO_CM_ROUGH ? EU_TO_CM_ROUGH[/** @type {keyof typeof EU_TO_CM_ROUGH} */ (eu)] : null;
  if (cm != null) return cm;
  const approx = Math.round((((eu + 133) / 5) + Number.EPSILON) * 10) / 10;
  return approx >= 20 && approx <= 35 ? approx : null;
}
