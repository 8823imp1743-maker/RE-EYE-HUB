/**
 * GET|POST /api/test-notify
 * CRON_SECRET 保護の OneSignal 疎通テスト（本番 iPhone 到達確認用）
 *
 * ?userId=u_xxx  … userId タグに絞る（推奨）
 * 省略時         … included_segments: ["Total Subscriptions"]
 */

import { buildOneSignalTargetingFromData } from '../lib/notification.js';
import { sanitizeUserId } from '../lib/user-settings.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const appId =
    process.env.ONESIGNAL_APP_ID || process.env.ONESIGNAL_KEY || '';
  const apiKey =
    process.env.ONESIGNAL_API_KEY ||
    process.env.ONESIGNAL_REST_KEY ||
    '';

  if (!appId || !apiKey) {
    return res.status(500).json({
      success: false,
      error: 'ONESIGNAL_APP_ID or ONESIGNAL_API_KEY not configured',
    });
  }

  const userId = sanitizeUserId(req.query?.userId || req.body?.userId || '');
  const targeting = userId
    ? buildOneSignalTargetingFromData({ userId })
    : { included_segments: ['Total Subscriptions'] };

  const body = {
    app_id: appId,
    ...targeting,
    headings: { en: 'RE-EYE-HUB テスト', ja: 'RE-EYE-HUB テスト' },
    contents: {
      en: '在庫復活通知のテストです',
      ja: '在庫復活通知のテストです',
    },
    url: 'https://re-eye-hub.vercel.app',
    data: {
      type: 'test_notify',
      userId: userId || undefined,
      opsSource: 'test_notify',
    },
  };

  try {
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Key ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: 'OneSignal API error',
        response: data,
        targeting: userId ? { userId } : { segment: 'Total Subscriptions' },
      });
    }

    return res.status(200).json({
      success: true,
      response: data,
      targeting: userId ? { userId } : { segment: 'Total Subscriptions' },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
