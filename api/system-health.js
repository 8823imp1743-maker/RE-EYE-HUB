/**
 * Vercel Serverless のエントリポイント（CORS + レート制限）。
 * 本体は functions 側の実装を呼び出す。
 */
import systemHealthHandler from '../functions/api/system-health.js';
import { attachExpressLikeResponse, ensureJsonBody, ensureQuery } from './_compat.js';
import { guardVercelApi } from './_security.js';

export default async function handler(req, res) {
  attachExpressLikeResponse(res);
  const gate = await guardVercelApi(req, res, { rateTier: 'default' });
  if (gate !== 'ok') return;

  try {
    ensureQuery(req);
    await ensureJsonBody(req);
    return await systemHealthHandler(req, res);
  } catch (e) {
    console.error('[api/system-health]', e);
    if (res.writableEnded) return;
    return res.status(200).json({
      ok: false,
      error: e?.message || 'internal error',
    });
  }
}

