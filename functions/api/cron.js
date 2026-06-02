/**
 * /api/cron — GitHub Actions 無料 Cron からのみ呼び出される監視トリガー。
 *
 * 認証: X-Cron-Secret ヘッダーと環境変数 CRON_SECRET が一致するか検証。
 * 実行: checkAllWatched() を呼び出し、全エントリのSERP監視を1サイクル実行。
 * コスト: 30分ごと・昼のみ（plan-config.js の STOCK_CONFIG による間隔制御が有効）。
 */

import { checkAllWatched } from './monitor.js';

function cronAuthOk(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const authHeader = req.headers.get
    ? (req.headers.get('authorization') || req.headers.get('Authorization') || '')
    : (req.headers.authorization || req.headers['Authorization'] || '');
  const xCronSecret = req.headers.get
    ? (req.headers.get('x-cron-secret') || req.headers.get('X-Cron-Secret') || '')
    : (req.headers['x-cron-secret'] || req.headers['X-Cron-Secret'] || '');
  return authHeader === `Bearer ${secret}` || xCronSecret === secret;
}

export default async function handler(req, res) {
  // api/index.js でも認証済みだが、直接到達時のためここでも両方式を受け付ける
  if (!cronAuthOk(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startMs = Date.now();
  try {
    const stats = await checkAllWatched();
    const elapsed = Date.now() - startMs;
    console.log(`[cron] checkAllWatched 完了 ${elapsed}ms stats=${JSON.stringify(stats || {})}`);
    return res.status(200).json({ ok: true, elapsed, stats: stats || null });
  } catch (e) {
    console.error('[cron] checkAllWatched 失敗:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
