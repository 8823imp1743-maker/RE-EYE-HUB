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

import { getRedis, withRedisRetry } from '../lib/redis.js';
import { userPlanKey } from '../lib/monitor-constants.js';

/** ブラウザ・CDN が 304 / 古いボディを返さないようにする */
function setNoStore(res) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

const TREND_TTL = 60 * 60 * 24 * 90; // 90日

const PLAN_TREND_SLOTS = {
  FREE: 3,
  STANDARD: 5,
  PRO: 5,
  VIP: 10,
};

/** 最終防衛ライン（想定外 plan / バグでも増えすぎないように） */
const TREND_MAX_SLOTS_ABSOLUTE = 10;

function normalizePlan(p) {
  const v = String(p || '').trim().toUpperCase();
  return PLAN_TREND_SLOTS[v] ? v : null;
}

async function resolveUserPlan(r, userId) {
  try {
    const raw = await r.get(userPlanKey(userId));
    const p = normalizePlan(raw);
    return p || 'FREE';
  } catch {
    return 'FREE';
  }
}

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
    const raw = await withRedisRetry(
      () => r.get(`user:trend:items:${userId}`),
      { label: 'trend:get' }
    );
    setNoStore(res);
    if (!raw) return res.status(200).json({ found: false, items: [] });
    let items = [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      items = Array.isArray(parsed) ? parsed : [];
    } catch (parseErr) {
      console.warn('[trend] corrupt data, treating as empty:', parseErr.message);
    }
    return res.status(200).json({ found: items.length > 0, items });
  } catch(e) {
    console.error('[trend] GET 失敗:', e.message);
    setNoStore(res);
    return res.status(200).json({ found: false, items: [], degraded: true });
  }
}

/** POST /api/trend  Body: { userId, items: [...] } */
async function handlePost(req, res) {
  const body = req.body || {};
  const userId = sanitizeUserId(body.userId);
  if (!userId) return res.status(400).json({ error: 'valid userId required' });

  const rawItems = Array.isArray(body.items) ? body.items : [];
  const itemsSanitized = rawItems
    .map(sanitizeItem)
    .filter(Boolean)
    .slice(0, TREND_MAX_SLOTS_ABSOLUTE);

  try {
    const r = getRedis();
    const plan = await resolveUserPlan(r, userId);
    const cap = PLAN_TREND_SLOTS[plan] || PLAN_TREND_SLOTS.FREE;
    const items = itemsSanitized.slice(0, Math.min(cap, TREND_MAX_SLOTS_ABSOLUTE));

    await r.set(`user:trend:items:${userId}`, JSON.stringify(items), { ex: TREND_TTL });
    setNoStore(res);
    return res.status(200).json({ saved: true, count: items.length, plan, cap });
  } catch(e) {
    console.error('[trend] POST 失敗:', e.message);
    return res.status(500).json({ error: 'internal error' });
  }
}
