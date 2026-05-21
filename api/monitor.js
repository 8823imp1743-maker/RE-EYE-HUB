import monitorHandler from '../functions/api/monitor.js';
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
    return await monitorHandler(req, res);
  } catch (e) {
    void captureIfCritical(e, { endpoint: 'monitor' });
    console.error('[api/monitor]', e);
    if (res.writableEnded) return;
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(
      JSON.stringify({
        error:
          'サーバーが一時的に応答できません（データストア接続）。しばらくしてから再度お試しください。',
        code: 'WRAPPER_ERROR',
        detail: e?.message || String(e),
        items: [],
      })
    );
  }
}

