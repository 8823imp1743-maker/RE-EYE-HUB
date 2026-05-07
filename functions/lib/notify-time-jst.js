/**
 * 時間帯重み・hour はすべて JST（Asia/Tokyo）
 */

export function getJstHour(timestampMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestampMs));
  const h = parts.find((p) => p.type === 'hour');
  return parseInt(h?.value || '0', 10);
}

/**
 * 仕様書の係数。（hour は JST 0–23 のみ対象）
 */
export function getTimeScoreHourJst(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 7 && h <= 9) return 1.2;
  if (h >= 12 && h <= 13) return 1.3;
  if (h >= 18 && h <= 23) return 1.5;
  return 0.7;
}

export function getTimeScoreJst(timestampMs = Date.now()) {
  return getTimeScoreHourJst(getJstHour(timestampMs));
}
