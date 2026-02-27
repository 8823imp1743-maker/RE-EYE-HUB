/**
 * POST /api/categories/register
 * カテゴリ＋マルチソース登録 & タイムゼロ・ベースライン作成
 * 「登録した瞬間に存在した情報は既読とし、それ以降の更新だけを通知する」を厳守
 */

import { getCategoryTree, registerSource, saveUserSubscription } from '../lib/categories.js';
import { getSeenKey } from '../lib/utils.js';
import { markSeen } from '../lib/redis.js';
import { normalizeItems } from '../lib/sns-normalizer.js';
import { sendJson } from '../lib/response.js';

function parseBody(req) {
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

  let payload;
  try {
    payload = await parseBody(req);
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { userId, categoryId, sources = [], baselineItems = [] } = payload;
  if (!userId || !categoryId) {
    sendJson(res, 400, { error: 'userId and categoryId are required' });
    return;
  }

  const tree = await getCategoryTree();
  const cat = tree.find(c => c.id === categoryId);
  if (!cat) {
    sendJson(res, 404, { error: 'Category not found' });
    return;
  }

  const marked = [];
  const validTypes = ['web', 'x', 'instagram', 'ec', 'fanclub'];

  // ソース登録
  for (const s of sources) {
    if (s.sourceId && validTypes.includes((s.type || 'web').toLowerCase())) {
      await registerSource(categoryId, {
        type: (s.type || 'web').toLowerCase(),
        sourceId: s.sourceId,
        name: s.name || s.sourceId,
        url: s.url
      });
    }
  }

  // タイムゼロ・ベースライン: 登録時点の全アイテムを seen に
  for (const entry of baselineItems) {
    const { sourceId, sourceType = 'web', items = [] } = entry;
    const st = String(sourceType).toLowerCase();
    const normalized = normalizeItems(items, st);
    for (const item of normalized) {
      const key = getSeenKey(userId, sourceId, item, st);
      await markSeen(key);
      marked.push({ sourceId, type: st });
    }
  }

  await saveUserSubscription(userId, categoryId, {
    sources: sources.map(s => ({ type: s.type, sourceId: s.sourceId })),
    baselineItems: baselineItems.length
  });

  sendJson(res, 200, {
    ok: true,
    categoryId,
    baseline: { marked: marked.length },
    message: 'タイムゼロ・ベースライン適用済み。以降の更新のみ通知します。'
  });
}
