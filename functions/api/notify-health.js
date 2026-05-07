/**
 * GET /api/notify-health?userId=xxx
 * 運用ヘルス: プラン別日次枠など（conversion トリガ判定用）
 */

import { getRedis, withRedisRetry } from '../lib/redis.js';
import { userPlanKey } from '../lib/monitor-constants.js';
import { coercePlanTier } from '../lib/notify-plan-policy.js';
import { sanitizeUserId } from '../lib/user-settings.js';
import { readFreeDailyNotifyUsage } from '../lib/free-user-daily-cap.js';
import {
  getJstHour,
  getTimeScoreJst,
  getTimeScoreHourJst,
} from '../lib/notify-time-jst.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const userId = sanitizeUserId(req.query?.userId);
  if (!userId) {
    return res.status(400).json({ error: 'valid userId required' });
  }

  try {
    const r = getRedis();
    let planRaw = null;
    try {
      planRaw = await withRedisRetry(() => r.get(userPlanKey(userId)), {
        label: 'notify-health:plan',
      });
    } catch {
      planRaw = null;
    }

    const plan = coercePlanTier(planRaw || 'FREE');
    const jstHour = getJstHour();
    const timeScore = getTimeScoreJst();
    const peakHint = timeScore >= 1.0;

    const usage = await readFreeDailyNotifyUsage(r, userId);

    /** 運用 KPI 用（フロントの「無料枠到達」「連続ヒット」等と連動） */
    const conversionHints = {
      dailyLimitReached:
        !!(usage.cap && usage.atLimit),
      /** 体感ベストの時間帯か（サーバ JST 推定スコア） */
      jstPeakWindowHint: peakHint,
      jstHour,
      timeScoreHourJst: getTimeScoreHourJst(jstHour),
      freeDaily: usage,
    };

    return res.status(200).json({
      ok: true,
      userId,
      plan,
      conversionHints,
    });
  } catch (e) {
    console.error('[notify-health]', e && e.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
}
