import { getSeenKey } from '../../lib/utils.js';
import { markSeen, isSeen } from '../../lib/redis.js';
import { shouldExclude, getNotificationCategory } from '../../lib/filters.js';
import { normalizeItems } from '../../lib/sns-normalizer.js';
import { sendOneSignalNotification } from '../../lib/notification.js';
import { sendJson } from '../../lib/response.js';

function parseBody(req) {
  // Firebase/Express では express.json() が req.body を展開済み
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const secret = req.headers['x-webhook-secret'];
  const expectedSecret = process.env.WEBHOOK_SECRET;
  // WEBHOOK_SECRET 未設定 or 合言葉不一致 → 即拒否
  if (!expectedSecret || secret !== expectedSecret) {
    sendJson(res, 401, { error: 'Unauthorized: 認証に失敗しました' });
    return;
  }

  let payload;
  try {
    payload = await parseBody(req);
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { userId, sourceId, sourceType = 'web', categoryId, items = [] } = payload;
  if (!userId || !sourceId) {
    sendJson(res, 400, { error: 'userId and sourceId are required' });
    return;
  }

  const st = String(sourceType).toLowerCase();
  const validTypes = ['web', 'x', 'instagram', 'ec', 'fanclub'];
  if (!validTypes.includes(st)) {
    sendJson(res, 400, { error: 'sourceType must be web, x, instagram, ec, or fanclub' });
    return;
  }

  const normalized = normalizeItems(items, st);
  const notified = [];
  const skipped = { seen: 0, excluded: 0 };

  for (const item of normalized) {
    const key = getSeenKey(userId, sourceId, item, st);
    if (await isSeen(key)) {
      skipped.seen++;
      continue;
    }

    const title = item.title || '新着お知らせ';
    const body = item.body || '';
    if (shouldExclude(title, body)) {
      await markSeen(key);
      skipped.excluded++;
      continue;
    }

    const { category, isImportant } = getNotificationCategory(title, body);
    const prefix = isImportant ? '[重要] ' : '';
    const displayTitle = `${prefix}[${category}] ${title}`;

    try {
      await sendOneSignalNotification({
        title: displayTitle,
        message: body.slice(0, 150),
        url: item.url || '',
        category,
        data: { isImportant: !!isImportant, categoryId: categoryId || null }
      });
      await markSeen(key);
      notified.push({ id: item.id, category, isImportant });
    } catch (err) {
      console.error('Notification Error:', err);
    }
  }

  sendJson(res, 200, {
    ok: true,
    notified: notified.length,
    skipped,
    items: notified
  });
}