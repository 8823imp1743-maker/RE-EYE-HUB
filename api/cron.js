import cronHandler from '../functions/api/cron.js';
import { attachExpressLikeResponse } from './_compat.js';
import { captureIfCritical } from './_sentry.js';

export default async function handler(req, res) {
  attachExpressLikeResponse(res);

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }

  try {
    return await cronHandler(req, res);
  } catch (e) {
    void captureIfCritical(e, { endpoint: 'cron' });
    console.error('[api/cron]', e);
    if (res.writableEnded) return;
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: e?.message || 'internal error' }));
  }
}
