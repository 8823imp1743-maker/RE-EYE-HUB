/**
 * GET  /api/user-settings?userId=xxx  — ユーザー設定取得（マイサイズ等）
 * POST /api/user-settings              — ユーザー設定保存（部分更新ではなく全体保存）
 *
 * Redis キー: user:settings:{userId}  TTL: 90日
 */
 
import { getRedis, withRedisRetry } from '../lib/redis.js';
import {
  USER_SETTINGS_TTL_SEC,
  sanitizeStoredUserSettings,
  sanitizeUserId,
  normalizeUserSettings,
  userSettingsKey,
} from '../lib/user-settings.js';
 
export default async function handler(req, res) {
  if (req.method === 'GET')  return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method Not Allowed' });
}
 
/** GET /api/user-settings?userId=xxx */
async function handleGet(req, res) {
  const userId = sanitizeUserId(req.query?.userId);
  if (!userId) return res.status(400).json({ error: 'valid userId required' });
 
  try {
    const r = getRedis();
    const key = userSettingsKey(userId);
    const raw = await withRedisRetry(() => r.get(key), { label: 'user-settings:get' });
    if (!raw) {
      return res.status(200).json({ found: false, userId, settings: null });
    }
    const settings = sanitizeStoredUserSettings(raw);
    if (!settings) {
      // 壊れたデータは「未設定」として返す（fail-open）
      return res.status(200).json({ found: false, userId, settings: null });
    }
    return res.status(200).json({ found: true, userId, settings });
  } catch (e) {
    console.error('[user-settings] GET 失敗:', e.message);
    return res.status(500).json({ error: 'internal error', found: false, userId, settings: null });
  }
}
 
/** POST /api/user-settings  Body: { userId, shoeCm?, clothing?, numeric? } */
async function handlePost(req, res) {
  const body = req.body || {};
  const userId = sanitizeUserId(body.userId);
  if (!userId) return res.status(400).json({ error: 'valid userId required' });
 
  const settings = normalizeUserSettings(body);
 
  try {
    const r = getRedis();
    const key = userSettingsKey(userId);
    await withRedisRetry(
      () => r.set(key, JSON.stringify(settings), { ex: USER_SETTINGS_TTL_SEC }),
      { label: 'user-settings:set' }
    );
    return res.status(200).json({ saved: true, userId, settings });
  } catch (e) {
    console.error('[user-settings] POST 失敗:', e.message);
    return res.status(500).json({ error: 'internal error', saved: false });
  }
}
