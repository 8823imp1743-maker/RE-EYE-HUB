/**
 * GET /api/poll-status?userId=xxx&keyword=yyy
 * フロントエンドが最新のポーリング結果を取得するエンドポイント
 *
 * Redis の `poll:results:{userId}:{keywordHash}` を読み取って返す。
 * キャッシュが存在しない場合は { found: false } を返す。
 */

import { createHash } from 'crypto';
import { getRedis }   from '../lib/redis.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { userId, keyword } = req.query;
  if (!userId || !keyword) {
    return res.status(400).json({ error: 'userId and keyword are required' });
  }

  const hash = createHash('sha256')
    .update(keyword.toLowerCase().trim())
    .digest('hex')
    .slice(0, 16);
  const cacheKey = `poll:results:${userId}:${hash}`;

  try {
    const r    = getRedis();
    const raw  = await r.get(cacheKey);
    if (!raw) {
      return res.status(200).json({ found: false });
    }
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json({ found: true, ...data });
  } catch (e) {
    console.error('Redis read error:', e.message);
    return res.status(500).json({ error: 'Cache read failed' });
  }
}
