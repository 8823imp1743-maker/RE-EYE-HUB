/**
 * cm とタイトルからキッズ候補
 * @param {number|null} cm
 * @param {string} title
 * @returns {boolean}
 */
export function inferKids(cm, title) {
  const t = String(title || '');
  if (/\bgs\b|\bps\b|\btd\b|kids|キッズ|ジュニア/i.test(t.toLowerCase() + t)) return true;
  if (Number.isFinite(cm) && cm != null && cm <= 25) return true;
  return false;
}
