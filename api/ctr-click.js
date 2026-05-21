import ctrClickHandler from '../functions/api/ctr-click.js';
import { attachExpressLikeResponse, ensureJsonBody, ensureQuery } from './_compat.js';
import { guardVercelApi } from './_security.js';
import { captureIfCritical } from './_sentry.js';

export default async function handler(req, res) {
  attachExpressLikeResponse(res);
  const gate = await guardVercelApi(req, res, { rateTier: 'default' });
  if (gate !== 'ok') return;

  try {
    ensureQuery(req);
    await ensureJsonBody(req);
    return await ctrClickHandler(req, res);
  } catch (e) {
    void captureIfCritical(e, { endpoint: 'ctr-click' });
    console.error('[api/ctr-click]', e);
    if (res.writableEnded) return;
    return res.status(500).json({ ok: false, error: e?.message || 'internal error' });
  }
}
