/**
 * RE_EYE 運用OS — anomaly detection（壊れ検知）
 * 監査OS（再現基盤）とは別レイヤーなので、report 本体とは混ぜない。
 */

/**
 * @param {any} report
 */
export function detectAnomaly(report) {
  const r = report && typeof report === 'object' ? report : {};
  const analysis = r.analysis && typeof r.analysis === 'object' ? r.analysis : {};

  const apiItems = Array.isArray(r.apiItems) ? r.apiItems.length : 0;
  const displayed = Array.isArray(r.displayItemIds) ? r.displayItemIds.length : 0;
  const excluded = Array.isArray(r.excludedItems) ? r.excludedItems.length : 0;

  let score = 0;

  // ① サイズ不一致
  score += (Number(analysis.sizeMismatchCount) || 0) * 2;

  // ② カラー不一致
  score += (Number(analysis.colorMismatchCount) || 0) * 2;

  // ③ 表示崩壊
  if (apiItems > 0 && displayed === 0) score += 50;
  if (displayed > apiItems) score += 30;

  // ④ ノイズ率
  const noise = excluded / Math.max(apiItems, 1);
  score += noise * 40;

  // ⑤ 極端崩壊補正
  if (apiItems === 0) score += 100;

  let level = 'ok';
  if (score > 100) level = 'critical';
  else if (score > 60) level = 'warning';

  return { score, level };
}

