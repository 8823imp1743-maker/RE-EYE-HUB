/**
 * GET  /api/user/settings?userId=xxx  — ユーザー設定取得
 * POST /api/user/settings              — ユーザー設定保存
 *
 * Redis キー: user:settings:{userId}  TTL: 365日
 *
 * 保存フィールド:
 *   gender, clothSize, shoeSize,
 *   hasChildren, childGender, childClothSize, childShoeSize,
 *   interests[], timezone
 */

import { getRedis } from '../lib/redis.js';

const SETTINGS_TTL = 60 * 60 * 24 * 365; // 365日

const ALLOWED_FIELDS = [
  'gender', 'clothSize', 'shoeSize',
  'hasChildren', 'childGender', 'childClothSize', 'childShoeSize',
  'interests', 'timezone',
];

function sanitizeUserId(uid) {
  if (!uid || typeof uid !== 'string') return null;
  // u_ + 英数字のみ（XSS / Injection 対策）
  if (!/^u_[a-z0-9]{6,32}$/i.test(uid)) return null;
  return uid;
}

export default async function handler(req, res) {
  if (req.method === 'GET')  return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method Not Allowed' });
}

/** GET /api/user/settings?userId=xxx */
async function handleGet(req, res) {
  const userId = sanitizeUserId(req.query.userId);
  if (!userId) return res.status(400).json({ error: 'valid userId required' });

  try {
    const r = getRedis();
    const raw = await r.get(`user:settings:${userId}`);
    if (!raw) return res.status(200).json({ found: false, settings: null });
    const settings = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json({ found: true, settings });
  } catch(e) {
    console.error('[user-settings] GET 失敗:', e.message);
    return res.status(500).json({ error: 'internal error' });
  }
}

/** POST /api/user/settings  Body: { userId, ...fields } */
async function handlePost(req, res) {
  const body = req.body || {};
  const userId = sanitizeUserId(body.userId);
  if (!userId) return res.status(400).json({ error: 'valid userId required' });

  // 許可フィールドのみ抽出（余計なキーを排除）
  const settings = {};
  for (const field of ALLOWED_FIELDS) {
    if (body[field] !== undefined) settings[field] = body[field];
  }

  if (Object.keys(settings).length === 0) {
    return res.status(400).json({ error: 'no valid fields provided' });
  }

  try {
    const r = getRedis();
    // 既存設定とマージ（上書きではなく patch 方式）
    const existing = await r.get(`user:settings:${userId}`);
    const prev = existing
      ? (typeof existing === 'string' ? JSON.parse(existing) : existing)
      : {};
    const merged = { ...prev, ...settings, updatedAt: Date.now() };
    await r.set(`user:settings:${userId}`, JSON.stringify(merged), { ex: SETTINGS_TTL });
    return res.status(200).json({ saved: true, settings: merged });
  } catch(e) {
    console.error('[user-settings] POST 失敗:', e.message);
    return res.status(500).json({ error: 'internal error' });
  }
}
