import { withRedisRetry } from './redis.js';

import { isPaidPlan } from './notify-plan-policy.js';



/**

 * 無料ユーザーの最短通知間隔（秒）。未設定または 0 で無効。

 * env RE_EYE_FREE_PUSH_MIN_GAP_SEC （例: 120）

 *

 * Redis: SET NX + EX で「直近送信からのインターバル」を実現

 */

export async function allowFreePushMinGap(r, userId, plan) {

  if (isPaidPlan(plan)) return true;

  const raw = Number(process.env.RE_EYE_FREE_PUSH_MIN_GAP_SEC ?? 120);

  const sec =

    Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 3600 * 24) : 0;

  if (!sec) return true;

  const id = String(userId || '').trim();

  if (!id) return true;

  const key = `nfc:gap:v1:${id}`;

  try {

    const nx = await withRedisRetry(() => r.set(key, String(Date.now()), { nx: true, ex: sec }), {

      label: 'free-min-gap-nx',

    });

    return nx != null;

  } catch {

    return true;

  }

}


