import notifyHealthHandler from '../functions/api/notify-health.js';
import { attachExpressLikeResponse, ensureQuery } from './_compat.js';
import { guardVercelApi } from './_security.js';

export default async function handler(req, res) {
  attachExpressLikeResponse(res);
  const gate = await guardVercelApi(req, res, { rateTier: 'default' });
  if (gate !== 'ok') return;

  try {
    ensureQuery(req);
    return await notifyHealthHandler(req, res);
  } catch (e) {
    console.error('[api/notify-health]', e);
    if (res.writableEnded) return;
    return res.status(500).json({ ok: false, error: e?.message || 'internal error' });
  }
}
