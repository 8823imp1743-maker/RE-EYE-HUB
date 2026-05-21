/**
 * OneSignal REST API によるプッシュ通知
 */

import { getRedis } from './redis.js';
import { incrNotifyAttemptsPerMinute } from './notify-metrics-redis.js';
import { freeDailyCapRecordSuccess } from './free-user-daily-cap.js';
import { opsJsonLog } from './notify-ops-log.js';
import { shouldApplyTagAndFilter, isPaidPlan } from './notify-plan-policy.js';
import { recordCtrTemplateSent } from './ctr-metrics.js';

/**
 * internal フィールドをデータペイロードから除く。
 * @param {Record<string, unknown>} data
 */
function sanitizePayloadData(data) {
  if (!data || typeof data !== 'object') return {};
  const {
    oneSignalFilters: _f,
    sizeTagKeys: _s,
    opsPlan: _p,
    ctrVariant: _cv,
    opsSource: _o,
    ctrHeat: _h,
    ...rest
  } = /** @type {Record<string, unknown>} */ (data);
  return rest;
}

/**
 * @param {{ userId?: string, sizeTagKeys?: string[], oneSignalFilters?: unknown[] }} data
 */
export function buildOneSignalTargetingFromData(data) {
  const explicit = data.oneSignalFilters;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return { filters: explicit };
  }

  const userId =
    data.userId != null && data.userId !== ''
      ? String(data.userId).trim()
      : null;
  const sizeTagKeys = Array.isArray(data.sizeTagKeys)
    ? [...new Set(data.sizeTagKeys.map((k) => String(k).trim()).filter(Boolean))].slice(
        0,
        8,
      )
    : [];

  const useSizeTagFilters =
    process.env.ONESIGNAL_USE_SIZE_TAG_FILTERS === '1' ||
    process.env.ONESIGNAL_USE_SIZE_TAG_FILTERS === 'true';

  if (userId) {
    let applyAndTags = !!(useSizeTagFilters && sizeTagKeys.length > 0);
    if (applyAndTags && !shouldApplyTagAndFilter(userId)) {
      opsJsonLog('tag_rollout_fallback_userId_only', {
        userId: userId.slice(0, 8),
      });
      applyAndTags = false;
    }
    if (applyAndTags && sizeTagKeys.length > 0) {
      return {
        filters: [
          { field: 'tag', key: 'userId', relation: '=', value: userId },
          {
            operator: 'OR',
            filters: sizeTagKeys.map((key) => ({
              field: 'tag',
              key,
              relation: '=',
              value: '1',
            })),
          },
        ],
      };
    }

    return {
      filters: [{ field: 'tag', key: 'userId', relation: '=', value: userId }],
    };
  }

  if (!userId && sizeTagKeys.length > 0) {
    if (!useSizeTagFilters) {
      return { included_segments: ['All'] };
    }
    return {
      filters: [
        {
          operator: 'OR',
          filters: sizeTagKeys.map((key) => ({
            field: 'tag',
            key,
            relation: '=',
            value: '1',
          })),
        },
      ],
    };
  }

  return { included_segments: ['All'] };
}

export async function sendOneSignalNotification({
  title,
  message,
  url,
  category,
  data = {},
}) {
  const appId =
    process.env.ONESIGNAL_KEY || process.env.ONESIGNAL_APP_ID;
  const apiKey =
    process.env.ONESIGNAL_REST_KEY ||
    process.env.ONESIGNAL_API_KEY ||
    '';

  if (!appId) {
    throw new Error('ONESIGNAL_KEY (App ID) must be set');
  }

  /** @type {Record<string, unknown>} */
  const dataObj = typeof data === 'object' && data ? data : {};
  const opsPlanRaw = /** @type {string|undefined} */ (dataObj.opsPlan);

  /** 本番前テスト用: 管理者 userId のみ送信（誤配信・コスト暴発防止） */
  const adminLockOn =
    process.env.RE_EYE_ADMIN_LOCK_ENABLE === '1' ||
    process.env.RE_EYE_ADMIN_LOCK_ENABLE === 'true';
  const adminOnlyId = String(process.env.RE_EYE_ADMIN_ONLY_USER_ID || '').trim();
  const payloadUserId =
    dataObj.userId != null && String(dataObj.userId).trim()
      ? String(dataObj.userId).trim()
      : '';

  /** userId 付き＝許可リスト比較。payload に userId が無い送信（将来のブロードキャスト等）は別イベントでログ */
  if (adminLockOn && adminOnlyId) {
    if (payloadUserId) {
      if (payloadUserId !== adminOnlyId) {
        opsJsonLog('safety_lock_active', {
          reason: 'not_admin_allowlist',
          targetUserId: payloadUserId.slice(0, 24),
        });
        return {};
      }
    } else {
      opsJsonLog('safety_lock_skip_non_user_target', {
        message:
          'no userId on payload; blocked in admin lock mode (broadcast/tag/webhook は payload に userId を付けるかロック解除)',
      });
      return {};
    }
  }

  try {
    const r = getRedis();
    await incrNotifyAttemptsPerMinute(r);
  } catch {
    /* ignore */
  }

  const targeting = buildOneSignalTargetingFromData(
    typeof data === 'object' && data ? data : {},
  );

  const body = {
    app_id: appId,
    ...targeting,
    headings: { en: title, ja: title },
    contents: { en: message, ja: message },
    url: url || undefined,
    data: {
      ...(typeof data === 'object' && data ? sanitizePayloadData(data) : {}),
      category: category || '新商品/お知らせ',
    },
  };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Key ${apiKey}`;

  let resJson;
  try {
    const res = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`OneSignal API error: ${res.status} ${text}`);
    }
    try {
      resJson = JSON.parse(text);
    } catch {
      resJson = { raw: text };
    }
  } catch (e) {
    opsJsonLog('notification_send_fail', {
      message: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  const nid = typeof resJson?.id === 'string' ? resJson.id : '';
  const recipients =
    typeof resJson?.recipients === 'number' ? resJson.recipients : null;

  const ctrTemplate =
    dataObj.ctrTemplate != null
      ? String(dataObj.ctrTemplate).trim().slice(0, 96)
      : '';
  opsJsonLog('notification_sent', {
    template: ctrTemplate || undefined,
    title: String(title || '').slice(0, 100),
    userId:
      dataObj.userId != null ? String(dataObj.userId).trim().slice(0, 24) : undefined,
    notifyId: nid || undefined,
    recipients: recipients ?? undefined,
  });

  opsJsonLog('notification_send', {
    notifyId: nid || undefined,
    recipients: recipients ?? undefined,
    hasId: !!nid,
  });

  if (recipients != null && recipients === 0) {
    opsJsonLog('notification_zero_delivery', { notifyId: nid || '' });
  }

  /** CTR の分母:「未配信」を除く（recipients=0 はカウントしない） */
  try {
    if (ctrTemplate && nid && recipients !== 0) {
      await recordCtrTemplateSent(getRedis(), ctrTemplate);
    }
  } catch {
    /* ignore */
  }

  /** FREE：日次通知キャップ（実績）— recipients が明示的に 0 ならカウントしない */
  try {
    const uid = dataObj.userId != null ? String(dataObj.userId).trim() : '';
    const pl = opsPlanRaw != null ? String(opsPlanRaw).trim() : '';
    const okHit =
      uid &&
      pl &&
      !!nid &&
      !isPaidPlan(pl) &&
      !(typeof recipients === 'number' && recipients === 0);
    if (okHit) {
      await freeDailyCapRecordSuccess(getRedis(), uid, pl);
    }
  } catch {
    /* ignore */
  }

  return resJson ?? {};
}
