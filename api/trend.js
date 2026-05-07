import trendHandler from '../functions/api/trend.js';
import { attachExpressLikeResponse, ensureJsonBody, ensureQuery } from './_compat.js';
import { guardVercelApi } from './_security.js';

export default async function handler(req, res) {
  attachExpressLikeResponse(res);
  const gate = await guardVercelApi(req, res, { rateTier: 'heavy' });
  if (gate !== 'ok') return;

  try {
    ensureQuery(req);
    await ensureJsonBody(req);
    return await trendHandler(req, res);
  } catch (e) {
    console.error('[api/trend]', e);
    if (res.writableEnded) return;
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(
      JSON.stringify({
        error: e?.message || 'internal error',
        items: [],
        debug: { wrapperError: e?.message || String(e) },
      })
    );
  }
}

