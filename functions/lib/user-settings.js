/**
 * ユーザー設定（マイサイズ等）の保存・取得ヘルパー
 *
 * 目的:
 * - poll.js 等が「検索のたびにサイズ入力」せずに済むようにする
 * - 監視エントリ（WATCH_TTL）とは独立した長期設定として保持する
 */
 
export const USER_SETTINGS_SCHEMA_VERSION = 1;
export const USER_SETTINGS_TTL_SEC = 60 * 60 * 24 * 90; // 90日（trend と同等）
 
/**
 * @param {string} userId
 */
export function userSettingsKey(userId) {
  return `user:settings:${userId}`;
}
 
/**
 * @param {any} uid
 * @returns {string|null}
 */
export function sanitizeUserId(uid) {
  if (!uid || typeof uid !== 'string') return null;
  if (!/^u_[a-z0-9]{6,32}$/i.test(uid)) return null;
  return uid;
}
 
const CLOTHING_ALLOWED = new Set([
  'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL',
]);
 
function round1(n) {
  return Math.round(n * 10) / 10;
}
 
/**
 * 入力（POST body）から設定を正規化する。
 *
 * @param {any} body
 * @returns {{
 *   schemaVersion: number,
 *   shoeCm: number|null,
 *   clothing: string|null,
 *   numeric: number|null,
 *   updatedAt: number
 * }}
 */
export function normalizeUserSettings(body) {
  const src = (body && typeof body === 'object') ? body : {};
 
  // shoeCm: 20.0〜35.0（小数1桁まで）
  let shoeCm = null;
  if (src.shoeCm != null && src.shoeCm !== '') {
    const n = Number(src.shoeCm);
    if (Number.isFinite(n)) {
      const r = round1(n);
      if (r >= 20.0 && r <= 35.0) shoeCm = r;
    }
  }
 
  // clothing: 許可リスト（大文字正規化）
  let clothing = null;
  if (src.clothing != null && src.clothing !== '') {
    const c = String(src.clothing).trim().toUpperCase().replace(/\s+/g, '');
    if (CLOTHING_ALLOWED.has(c)) clothing = c;
  }
 
  // numeric: 20〜60（整数）
  let numeric = null;
  if (src.numeric != null && src.numeric !== '') {
    const n = Number(src.numeric);
    if (Number.isFinite(n)) {
      const i = Math.round(n);
      if (i >= 20 && i <= 60) numeric = i;
    }
  }
 
  return {
    schemaVersion: USER_SETTINGS_SCHEMA_VERSION,
    shoeCm,
    clothing,
    numeric,
    updatedAt: Date.now(),
  };
}
 
/**
 * Redis から読んだ値を安全に整形する（欠損・型崩れに耐える）。
 * @param {any} raw
 */
export function sanitizeStoredUserSettings(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') return null;
 
  const shoeCm =
    typeof obj.shoeCm === 'number' && Number.isFinite(obj.shoeCm)
      ? round1(obj.shoeCm)
      : null;
 
  const clothing =
    typeof obj.clothing === 'string' && CLOTHING_ALLOWED.has(obj.clothing.toUpperCase())
      ? obj.clothing.toUpperCase()
      : null;
 
  const numeric =
    typeof obj.numeric === 'number' && Number.isFinite(obj.numeric)
      ? Math.round(obj.numeric)
      : null;
 
  const updatedAt =
    typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt)
      ? Math.round(obj.updatedAt)
      : 0;
 
  return {
    schemaVersion: USER_SETTINGS_SCHEMA_VERSION,
    shoeCm,
    clothing,
    numeric,
    updatedAt,
  };
}
