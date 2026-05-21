/**
 * POST /api/sources/:sourceId/baseline
 * 登録時ベースライン作成 - 受け取った items をすべて seen として保存
 * vercel.json の rewrite で /api/sources/:sourceId/baseline → 本ファイル（sourceId は query で渡る）
 */

import { getSeenKey } from '../lib/utils.js';
import { markSeen } from '../lib/redis.js';
import { sendJson } from '../lib/response.js';

function parseBody(req) {
  // Firebase/Express では express.json() が req.body を展開済み
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  // セキュリティ: X-Webhook-Secret 照合
  const secret = req.headers['x-webhook-secret'];
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const sourceId = req.query?.sourceId;
  if (!sourceId) {
    sendJson(res, 400, { error: 'sourceId is required' });
    return;
  }

  let payload;
  try {
    payload = await parseBody(req);
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { userId, sourceType = 'web', items = [] } = payload;
  if (!userId || !Array.isArray(items)) {
    sendJson(res, 400, {
      error: 'Missing required fields: userId, items (array)'
    });
    return;
  }

  const validSourceTypes = ['web', 'x', 'instagram', 'ec', 'fanclub'];
  const st = String(sourceType).toLowerCase();
  if (!validSourceTypes.includes(st)) {
    sendJson(res, 400, { error: 'sourceType must be web, x, or instagram' });
    return;
  }

  let marked = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    const key = getSeenKey(userId, sourceId, item, st);
    await markSeen(key);
    marked++;
  }

  sendJson(res, 200, {
    ok: true,
    sourceId,
    baseline: { marked }
  });
}
