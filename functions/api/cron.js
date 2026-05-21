/**
 * /api/cron — GitHub Actions 無料 Cron からのみ呼び出される監視トリガー。
 *
 * 認証: X-Cron-Secret ヘッダーと環境変数 CRON_SECRET が一致するか検証。
 * 実行: checkAllWatched() を呼び出し、全エントリのSERP監視を1サイクル実行。
 * コスト: 30分ごと・昼のみ（plan-config.js の STOCK_CONFIG による間隔制御が有効）。
 */

import { checkAllWatched } from './monitor.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 認証チェック
  const secret = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'];
  if (!secret || !provided || provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startMs = Date.now();
  try {
    await checkAllWatched();
    const elapsed = Date.now() - startMs;
    console.log(`[cron] checkAllWatched 完了 ${elapsed}ms`);
    return res.status(200).json({ ok: true, elapsed });
  } catch (e) {
    console.error('[cron] checkAllWatched 失敗:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
