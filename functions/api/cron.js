/**
 * 認証: X-Cron-Secret ヘッダーと環境変数 CRON_SECRET が一致するか検証。
 * 実行: checkAllWatched() を呼び出し、全エントリのSERP監視を1サイクル実行。
 * トリガー: cron-job.org（推奨）または workflow_dispatch（GitHub Actions 手動）
 */

import { checkAllWatched } from './monitor.js';
import { cronAuthOk } from '../lib/cron-auth.js';

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
