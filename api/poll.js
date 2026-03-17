/**
 * POST /api/poll
 * ショップ横断リアルタイムポーリングエンドポイント
 *
 * リクエスト Body:
 *   { keyword: string, userId: string, plan?: 'FREE'|'STANDARD'|'PRO'|'VIP' }
 *
 * 認証:
 *   Authorization: Bearer <WEBHOOK_SECRET>
 *
 * レスポンス:
 *   { newItems, allItems, errors, checkedAt }
 *
 * データフロー:
 *   searchAll() → seenチェック(Redis) → filters.js → OneSignal通知 → Redisキャッシュ保存
 */

import { createHash } from 'crypto';
import { searchAll }  from '../lib/shop-adapters/index.js';
import { getRedis, markSeen, isSeen } from '../lib/redis.js';
import { shouldExclude, getNotificationCategory } from '../lib/filters.js';
import { sendOneSignalNotification } from '../lib/notification.js';

// プラン別の検索件数上限
const PLAN_MAX_RESULTS = {
  FREE:     5,
  STANDARD: 15,
  PRO:      30,
  VIP:      30,
};

// Redis キャッシュ TTL（秒）
const CACHE_TTL = {
  FREE:     3600,  // 1時間
  STANDARD: 600,   // 10分
  PRO:      60,    // 1分
  VIP:      60,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 認証チェック
  const secret = process.env.WEBHOOK_SECRET;
  const authHeader = req.headers.authorization || '';
  if (secret && authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { keyword, userId, plan = 'FREE' } = req.body || {};
  if (!keyword || !userId) {
    return res.status(400).json({ error: 'keyword and userId are required' });
  }

  const maxResults = PLAN_MAX_RESULTS[plan] || 5;

  // 1. 全アクティブショップで並列検索
  const { items: allItems, errors } = await searchAll(keyword, {
    maxResults,
    inStockOnly: false, // 在庫なしも取得（変化を検出するため）
  });

  // 2. 各アイテムの seenチェック → 未見のみ抽出
  const newItems = [];
  await Promise.all(
    allItems.map(async item => {
      // seenキー: seen:userId:sourceId:sha256(itemId)
      const hash = createHash('sha256').update(item.itemId).digest('hex');
      const key  = `seen:${userId}:${item.sourceId}:${hash}`;
      const seen = await isSeen(key);
      if (!seen) {
        newItems.push(item);
        await markSeen(key); // タイムゼロ・ベースライン：初回見た時点でマーク
      }
    })
  );

  // 3. フィルタリング（除外ワード除去・カテゴリ分類）
  const filteredNew = newItems.filter(item =>
    !shouldExclude(item.title, item.title) // LIVE/チケット等は除外
  );

  // 4. 在庫ありの新着アイテムがあれば OneSignal でプッシュ通知
  const inStockNew = filteredNew.filter(i => i.available);
  if (inStockNew.length > 0) {
    try {
      const top = inStockNew[0];
      const { category, isImportant } = getNotificationCategory(top.title, top.title);
      const prefix = isImportant ? '[重要] ' : '';
      await sendOneSignalNotification({
        title:    `${prefix}${top.shopName}で在庫あり`,
        message:  `${top.title} / ¥${top.price.toLocaleString()}`,
        url:      top.url,
        category,
      });
    } catch (e) {
      // 通知失敗はログのみ（ポーリング結果は返す）
      console.error('OneSignal push failed:', e.message);
    }
  }

  // 5. 結果を Redis にキャッシュ（フロントのステータス取得用）
  const cacheKey = buildCacheKey(userId, keyword);
  const ttl = CACHE_TTL[plan] || 3600;
  try {
    const r = getRedis();
    await r.set(cacheKey, JSON.stringify({
      allItems,
      newItems: filteredNew,
      checkedAt: Date.now(),
    }), { ex: ttl });
  } catch (e) {
    console.error('Redis cache write failed:', e.message);
  }

  return res.status(200).json({
    newItems:  filteredNew,
    allItems,
    errors,
    checkedAt: Date.now(),
  });
}

/** Redis キャッシュキー生成 */
function buildCacheKey(userId, keyword) {
  const hash = createHash('sha256').update(keyword.toLowerCase().trim()).digest('hex').slice(0, 16);
  return `poll:results:${userId}:${hash}`;
}
