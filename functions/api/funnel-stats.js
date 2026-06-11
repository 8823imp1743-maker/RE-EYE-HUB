/**
 * GET /api/funnel-stats?limit=50
 * 内部用 — Authorization: Bearer WEBHOOK_SECRET
 */

import { getRedis } from '../lib/redis.js';
import { buildFunnelStats } from '../lib/purchase-funnel.js';

function authorizeInternal(req) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true;
  const auth = String(req.headers.authorization || '');
  return auth === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!authorizeInternal(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Cache-Control', 'private, no-store');

  const limit = Math.floor(Number(req.query?.limit) || 50);

  try {
    const r = getRedis();
    const stats = await buildFunnelStats(r, { limit });
    return res.status(200).json({ ok: true, ...stats });
  } catch (e) {
    console.error('[funnel-stats]', e && e.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
}
