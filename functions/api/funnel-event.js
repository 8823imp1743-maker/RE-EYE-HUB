/**
 * POST /api/funnel-event
 * Body: { funnelId: string, stage: 'click'|'arrival', userId?: string }
 */

import { getRedis } from '../lib/redis.js';
import { sanitizeUserId } from '../lib/user-settings.js';
import { funnelIdIsRegistered, recordFunnelStage } from '../lib/purchase-funnel.js';
import { opsJsonLog } from '../lib/notify-ops-log.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const funnelId = String(body.funnelId || '').trim().slice(0, 32);
  const stage = String(body.stage || '').trim();
  const userId = sanitizeUserId(body.userId);

  if (!funnelId) {
    return res.status(400).json({ ok: false, error: 'funnelId required' });
  }
  if (stage !== 'click' && stage !== 'arrival') {
    return res.status(400).json({ ok: false, error: 'stage must be click or arrival' });
  }

  try {
    const r = getRedis();
    const registered = await funnelIdIsRegistered(r, funnelId);
    if (!registered) {
      opsJsonLog('purchase_funnel_reject', { reason: 'unknown_funnel_id', funnelId, stage });
      return res.status(404).json({ ok: false, error: 'funnel_not_found' });
    }

    const count = await recordFunnelStage(r, funnelId, stage, {
      userId,
      opsSource: 'client',
    });

    return res.status(200).json({ ok: true, funnelId, stage, count });
  } catch (e) {
    console.error('[funnel-event]', e && e.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
}
