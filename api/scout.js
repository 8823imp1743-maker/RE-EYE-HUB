import scoutHandler from '../functions/api/scout.js';
import { attachExpressLikeResponse, ensureJsonBody, ensureQuery } from './_compat.js';

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  attachExpressLikeResponse(res);
  applyCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    ensureQuery(req);
    await ensureJsonBody(req);
    return await scoutHandler(req, res);
  } catch (e) {
    console.error('[api/scout]', e);
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

