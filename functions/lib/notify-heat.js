/**
 * ヒートスコア（オークション等を内部フラグのみに使う）。
 * notifications 文言には載せず、キュー優先やログ用。
 */

/** @returns {{ score: number; label: string }} */
export function computeHeatSignals(entry) {

  const list = typeof entry?.price === 'number' && entry.price > 0 ? entry.price : 0;

  const auc = typeof entry?.auctionMin === 'number' && entry.auctionMin > 0 ? entry.auctionMin : 0;

  let score = 0;

  const noStockDays =

    typeof entry?.noStockEstimateDays === 'number' ? entry.noStockEstimateDays : 0;



  if (list > 0 && auc > 0) {

    score += Math.min((auc / list) * 50, 50);

  }

  score += Math.min(noStockDays * 5, 50);



  let label = 'normal';

  if (score > 80) label = 'high';

  else if (score > 55) label = 'elevated';

  return { score: Math.min(Math.round(score), 100), label };

}


