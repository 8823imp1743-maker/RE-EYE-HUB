/**
 * GET  /api/trend?userId=xxx  — トレンド見守り一覧取得
 * POST /api/trend              — トレンド見守り一覧保存（全置換）
 *
 * Redis キー: user:trend:items:{userId}  TTL: 90日
 *
 * 1ユーザー最大 TREND_MAX_SLOTS 件（VIP:10 / PRO:5 / STANDARD:5 / FREE:3）
 * スロット管理はフロントが責任を持ち、API はそのまま保存する。
 * 上限チェックはバックエンドでも二重ガードする。
 */

import { getRedis } from '../lib/redis.js';

const TREND_TTL       = 60 * 60 * 24 * 90; // 90日
const TREND_MAX_SLOTS = 10;                  // バックエンド側の絶対上限

function sanitizeUserId(uid) {
  if (!uid || typeof uid !== 'string') return null;
  if (!/^u_[a-z0-9]{6,32}$/i.test(uid)) return null;
  return uid;
}

/** アイテムから安全なフィールドのみ抽出 */
function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id:           String(raw.id           || '').slice(0, 128),
    title:        String(raw.title        || '').slice(0, 500),
    releaseAt:    Number(raw.releaseAt)   || 0,
    releaseLabel: String(raw.releaseLabel || '').slice(0, 100),
    sourceUrl:    String(raw.sourceUrl    || '').slice(0, 1000),
    shop:         String(raw.shop         || '').slice(0, 200),
    status:       ['WATCHING','CONFIRMED','HISTORY'].includes(raw.status) ? raw.status : 'WATCHING',
    addedAt:      Number(raw.addedAt)     || Date.now(),
    keyword:      String(raw.keyword      || '').slice(0, 200),
  };
}

export default async function handler(req, res) {
  if (req.method === 'GET')  return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method Not Allowed' });
}

/** GET /api/trend?userId=xxx */
async function handleGet(req, res) {
  const userId = sanitizeUserId(req.query.userId);
  if (!userId) return res.status(400).json({ error: 'valid userId required' });

  try {
    const r = getRedis();
    const raw = await r.get(`user:trend:items:${userId}`);
    if (!raw) return res.status(200).json({ found: false, items: [] });
    const items = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json({ found: true, items: Array.isArray(items) ? items : [] });
  } catch(e) {
    console.error('[trend] GET 失敗:', e.message);
    return res.status(500).json({ error: 'internal error', items: [] });
  }
}

/** POST /api/trend  Body: { userId, items: [...] } */
async function handlePost(req, res) {
  const body = req.body || {};
  const userId = sanitizeUserId(body.userId);
  if (!userId) return res.status(400).json({ error: 'valid userId required' });

  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems
    .map(sanitizeItem)
    .filter(Boolean)
    .slice(0, TREND_MAX_SLOTS); // 上限を超えたら切り捨て

  try {
    const r = getRedis();
    await r.set(`user:trend:items:${userId}`, JSON.stringify(items), { ex: TREND_TTL });
    return res.status(200).json({ saved: true, count: items.length });
  } catch(e) {
    console.error('[trend] POST 失敗:', e.message);
    return res.status(500).json({ error: 'internal error' });
  }
}
