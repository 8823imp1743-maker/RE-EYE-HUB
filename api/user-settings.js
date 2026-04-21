import userSettingsHandler from '../functions/api/user-settings.js';
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
    return await userSettingsHandler(req, res);
  } catch (e) {
    console.error('[api/user-settings]', e);
    if (res.writableEnded) return;
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(
      JSON.stringify({
        error: e?.message || 'internal error',
        found: false,
        settings: null,
        debug: { wrapperError: e?.message || String(e) },
      })
    );
  }
}
