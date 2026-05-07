/**
 * 「通知の質」スコア。無料ユーザーのノイズ抑制に使う。
 * （shoe-size-gate.js のサイズ許容とは独立・あと段のフィルタ）
 */

import { isPaidPlan } from './notify-plan-policy.js';

/**
 * @param {{
 *   available?: boolean,
 *   price?: number,
 *   listPrice?: number,
 *   title?: string,
 * }} ctx
 */
export function computeLtqScore(ctx) {
  let s = 0;
  if (ctx.available === false) return 0;

  const price = typeof ctx.price === 'number' ? ctx.price : NaN;
  const list = typeof ctx.listPrice === 'number' ? ctx.listPrice : NaN;

  if (Number.isFinite(price) && Number.isFinite(list) && list > 0) {
    const ratio = price / list;
    if (ratio <= 2.5 && ratio >= 0.5) s += 1;
    if (ratio <= 1.05) s += 2;
  }

  const title = String(ctx.title || '');
  const hay = `${title}`;
  const hot =
    /\b(restocks?|リストック|復活|限定|発売|復刻)\b|リストック|復活|限定|発売|復刻/u.test(hay);
  if (hot) s += 2;

  const scarce =
    /\b(残り|わずか|ラスト|僅か|sold\s*out|品切れ|完売)\b|残\d/u.test(title);
  if (scarce) s += 3;

  return s;
}

/**
 * FREE のみ LOW スコアをドロップ。PAID は原則スキップしない。
 */
export function shouldSkipLtqFree({
  plan,
  score,
  minScore,
  skipPaidLtq,
}) {
  const sk = typeof score === 'number' ? score : 0;
  const min =
    typeof minScore === 'number' && Number.isFinite(minScore) ? minScore : 0;
  if (min <= 0) return false;
  if (!skipPaidLtq && isPaidPlan(plan)) return false;
  return sk < min;
}
