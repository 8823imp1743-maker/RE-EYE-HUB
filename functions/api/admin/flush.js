/**
 * POST /api/admin/flush
 * Redis の intel:seen:* キャッシュを全クリアする管理エンドポイント。
 * WEBHOOK_SECRET 認証必須。
 *
 * 用途: 0件バグのデバッグ時、全アイテムが既読扱いになっている場合にキャッシュをリセット。
 */

import { getRedis } from '../../lib/redis.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // WEBHOOK_SECRET 認証
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mode = (req.body && req.body.mode) || 'intel';

  try {
    const redis = getRedis();

    if (mode === 'all') {
      // 全キー削除（開発環境のみ推奨）
      await redis.flushall();
      console.log('[admin/flush] FLUSHALL 実行完了');
      return res.status(200).json({ ok: true, mode: 'all', message: 'FLUSHALL 完了' });
    }

    // intel:seen:* キーのみスキャン削除（本番推奨）
    let cursor = 0;
    let deleted = 0;
    do {
      const result = await redis.scan(cursor, { match: 'intel:seen:*', count: 100 });
      cursor = result[0];
      const keys = result[1];
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== 0);

    console.log(`[admin/flush] intel:seen:* キー ${deleted} 件削除完了`);
    return res.status(200).json({ ok: true, mode: 'intel', deleted, message: `intel:seen:* ${deleted} 件クリア完了` });

  } catch (err) {
    console.error('[admin/flush] エラー:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
