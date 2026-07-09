/**
 * GET  /api/user-settings?userId=xxx  — ユーザー設定取得（マイサイズ等）
 * POST /api/user-settings              — ユーザー設定保存（**body に含まれるキーだけ**既存にマージ。未送信の adult キーを null 潰ししない）
 *
 * レスポンスの `settings` は常に `sanitizeStoredUserSettings` 後の正規形
 * （都道府県・大人の靴 cm / 服、子の child* 等）。
 *
 * **隔離**: GET/POST はいずれも `sanitizeUserId` 通過後の ID の**その人専用キー**のみread/write。子を含め他 userId の箱を越えない（キー衝突なしの設計）。
 *
 * Redis キー: user:settings:{userId}  TTL: 90日
 */
 
import { getRedis, withRedisRetry } from '../lib/redis.js';
import {
  USER_SETTINGS_TTL_SEC,
  USER_SETTINGS_SCHEMA_VERSION,
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
    return res.status(200).json({ error: 'redis_unavailable', found: false, userId, settings: null, degraded: true });
  }
}
 
/** POST /api/user-settings  Body: { userId, shoeCm?, clothing?, numeric?, prefecture?, childGender?, childClothSize?, childShoeSize? } */
async function handlePost(req, res) {
  const body = req.body || {};
  const userId = sanitizeUserId(body.userId);
  if (!userId) return res.status(400).json({ error: 'valid userId required' });
 
  try {
    const r = getRedis();
    const key = userSettingsKey(userId);
    const raw = await withRedisRetry(() => r.get(key), { label: 'user-settings:get-for-merge' });
    let prev = {};
    if (raw) {
      try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (o && typeof o === 'object') prev = o;
      } catch {
        prev = {};
      }
    }
    const n = normalizeUserSettings(body);
    // body に含まれるキーだけ上書き（未送信の adult キーは null にしない）
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const base = { ...prev, updatedAt: Date.now(), schemaVersion: USER_SETTINGS_SCHEMA_VERSION };
    if (has('shoeCm')) base.shoeCm = n.shoeCm;
    if (has('clothing')) base.clothing = n.clothing;
    if (has('numeric')) base.numeric = n.numeric;
    if (has('prefecture')) base.prefecture = n.prefecture;
    if (has('childGender')) base.childGender = n.childGender;
    if (has('childClothSize')) base.childClothSize = n.childClothSize;
    if (has('childShoeSize')) base.childShoeSize = n.childShoeSize;
    delete base.glovesSml;
    delete base.childGlovesSml;
    const settings = base;

    await withRedisRetry(
      () => r.set(key, JSON.stringify(settings), { ex: USER_SETTINGS_TTL_SEC }),
      { label: 'user-settings:set' }
    );
    return res.status(200).json({
      saved: true,
      userId,
      settings: sanitizeStoredUserSettings(settings),
    });
  } catch (e) {
    console.error('[user-settings] POST 失敗:', e.message);
    return res.status(500).json({ error: 'internal error', saved: false });
  }
}
