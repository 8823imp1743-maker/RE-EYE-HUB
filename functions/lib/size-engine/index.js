/**
 * サイズエンジン — エントリ
 * PDP 構造解析本体は pdp-shoe-stock（analyzePdpHtmlForShoeCm）を維持し、
 * ターゲット cm 配列の解決・スコア補助を集約する。
 */

export { inferGenderFromText } from './gender.js';
export { inferKids } from './kids.js';
export { usToCm, euRoughToCm } from './convert.js';
export {
  resolveCmTargetsForProfile,
  coerceNum,
  brandWmOffsetCm,
  normalizeSize,
} from './normalize.js';
export { haystackCmGapTierBonus, cmDistanceTierBonus, apparelAlphaGapBonus } from './score.js';
