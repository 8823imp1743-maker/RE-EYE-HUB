/**
 * Vercel Serverless のエントリポイントのみ（レート制限・JSON 正規化）。
 * 在庫検索の本体実装は {@link ../functions/api/search.js} のみ — 二重実装は行わない。
 */
import searchHandler from '../functions/api/search.js';
import { attachExpressLikeResponse, ensureJsonBody, ensureQuery } from './_compat.js';
import { guardVercelApi } from './_security.js';
import { applySearchMemoryShield } from './_search-vercel-memory.js';

export default async function handler(req, res) {
  attachExpressLikeResponse(res);
  const gate = await guardVercelApi(req, res, { rateTier: 'search' });
  if (gate !== 'ok') return;

  try {
    ensureQuery(req);
    await ensureJsonBody(req);
    return await applySearchMemoryShield(req, res, searchHandler);
  } catch (e) {
    console.error('[api/search]', e);
    if (res.writableEnded) return;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(
      JSON.stringify({
        found: false,
        items: [],
        normalizedKeyword: '',
        errors: [e?.message || 'internal error'],
        sourceNote: 'rakuten_yahoo_rule_based',
        debug: { wrapperError: e?.message || String(e) },
      })
    );
  }
}

