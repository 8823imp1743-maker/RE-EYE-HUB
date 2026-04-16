/**
 * マルチソース型カテゴリモデル
 * Yahoo!ショッピング風：カテゴリ × 複数ソース（EC/公式サイト/X/ファンクラブ等）
 */

import { getRedis } from './redis.js';

const CATEGORY_KEY = 'categories:tree';
const SOURCE_KEY = 'source:';

export const SOURCE_TYPES = {
  ec: 'ECサイト',
  web: '公式サイト',
  x: 'X (Twitter)',
  instagram: 'Instagram',
  fanclub: 'ファンクラブ'
};

/** デフォルトカテゴリツリー（Yahoo!ショッピング風） */
export const DEFAULT_CATEGORIES = [
  { id: 'game', name: 'ゲーム・おもちゃ', parentId: null, order: 1, sources: [] },
  { id: 'game-figure', name: 'フィギュア・ホビー', parentId: 'game', order: 1, sources: [] },
  { id: 'game-card', name: 'トレカ・カードゲーム', parentId: 'game', order: 2, sources: [] },
  { id: 'goods', name: 'アニメ・キャラクターグッズ', parentId: null, order: 2, sources: [] },
  { id: 'fanclub', name: 'ファンクラブ', parentId: null, order: 3, sources: [] },
  { id: 'limited', name: '限定品・プレミアム', parentId: null, order: 4, sources: [] }
];

/**
 * カテゴリツリー取得（UI用）
 */
export async function getCategoryTree() {
  try {
    const r = getRedis();
    const stored = await r.get(CATEGORY_KEY);
    if (stored) {
      const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (_) {}
  return DEFAULT_CATEGORIES;
}

/**
 * カテゴリにソースを登録
 * @param {string} categoryId
 * @param {object} source - { type, sourceId, name?, url? }
 */
export async function registerSource(categoryId, source) {
  const tree = await getCategoryTree();
  const cat = tree.find(c => c.id === categoryId);
  if (!cat) return null;
  if (!cat.sources) cat.sources = [];
  const existing = cat.sources.find(s => s.sourceId === source.sourceId);
  if (!existing) {
    cat.sources.push({
      type: source.type || 'web',
      sourceId: source.sourceId,
      name: source.name || source.sourceId,
      url: source.url || null
    });
  }
  await saveCategoryTree(tree);
  return cat;
}

/**
 * ユーザーがカテゴリを購読登録（ベースライン用メタデータ）
 * key: sub:{userId}:{categoryId} → { sources: [...], baselineAt }
 */
export async function getUserSubscription(userId, categoryId) {
  const r = getRedis();
  const key = `sub:${userId}:${categoryId}`;
  const val = await r.get(key);
  return val;
}

export async function saveUserSubscription(userId, categoryId, data) {
  const r = getRedis();
  const key = `sub:${userId}:${categoryId}`;
  await r.set(key, JSON.stringify({ ...data, baselineAt: new Date().toISOString() }), { ex: 60 * 60 * 24 * 365 });
}

async function saveCategoryTree(tree) {
  const r = getRedis();
  await r.set(CATEGORY_KEY, JSON.stringify(tree), { ex: 60 * 60 * 24 * 365 });
}
