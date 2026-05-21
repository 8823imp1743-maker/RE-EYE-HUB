import scoutHandler from '../functions/api/scout.js';
import { attachExpressLikeResponse, ensureJsonBody, ensureQuery } from './_compat.js';
import { guardVercelApi } from './_security.js';
import { captureIfCritical } from './_sentry.js';

export default async function handler(req, res) {
  attachExpressLikeResponse(res);
  const gate = await guardVercelApi(req, res, { rateTier: 'heavy' });
  if (gate !== 'ok') return;

  try {
    ensureQuery(req);
    await ensureJsonBody(req);
    return await scoutHandler(req, res);
  } catch (e) {
    void captureIfCritical(e, { endpoint: 'scout' });
    console.error('[api/scout] phase=wrapper', {
      message: e?.message || String(e),
      name: e?.name,
      stack: e?.stack ? String(e.stack).slice(0, 1500) : undefined,
    });
    if (res.writableEnded) return;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(
      JSON.stringify({
        ok: false,
        newCount: 0,
        items: [],
        errors: [e?.message || 'internal error'],
        debug: { wrapperError: e?.message || String(e) },
      })
    );
  }
}

