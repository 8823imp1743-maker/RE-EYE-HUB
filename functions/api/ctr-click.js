/**
 * POST /api/ctr-click
 * Body: { template: string, userId?: string }
 * CTR クリック計測 → Redis incr ctr:click:*
 */

import { getRedis } from '../lib/redis.js';
import { recordCtrTemplateClick } from '../lib/ctr-metrics.js';
import { sanitizeUserId } from '../lib/user-settings.js';

function normalizeTemplate(raw) {
  const s = typeof raw === 'string' ? raw.trim().slice(0, 96) : '';
  return s || '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  try {
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const template = normalizeTemplate(body.template ?? body.templateId);
    const uidRaw = sanitizeUserId(body.userId);
    const uidTrunc = uidRaw ? uidRaw.slice(0, 24) : 'anon';

    if (!template) {
      return res.status(400).json({ ok: false, error: 'template required' });
    }

    const r = getRedis();
    await recordCtrTemplateClick(r, template, uidTrunc);

    return res.status(200).json({
      ok: true,
      template,
      userIdMatched: !!uidRaw,
    });
  } catch (e) {
    console.error('[ctr-click]', e && e.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
}
