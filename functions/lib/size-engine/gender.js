/**
 * SERP／タイトルから性別ヒューリスティック（高精度PDPとは別レイヤーの補助）
 * @param {string} text
 * @returns {'men'|'women'|'kids'|'unknown'}
 */
export function inferGenderFromText(text) {
  const t = String(text || '');
  const low = t.toLowerCase();

  if (/\bkids\b|キッズ|ジュニア|\b(gs|ps|td)\b|子ども/i.test(low + t)) {
    return 'kids';
  }
  if (/wmns|women|レディース|ウィメン|ladies|\bw'?s\b|レディース|女性用/i.test(low + t)) {
    return 'women';
  }
  if (/(\bmen'?s\b|メンズ|男性用|mens|gent)/i.test(low + t)) {
    return 'men';
  }
  return 'unknown';
}
