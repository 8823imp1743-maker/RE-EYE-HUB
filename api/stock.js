/**
 * POST /api/stock
 * 在庫復活・品切れ監視エンドポイント
 *
 * リクエスト Body:
 *   { targets: [{ url: string, keyword?: string }] }
 *   最大 MAX_TARGETS 件。https:// から始まる URL のみ受け付ける。
 *
 * レスポンス:
 *   { ok, results: [{ status, url }], errors, checkedAt }
 *
 * status 値:
 *   'in_stock'      — 在庫あり（カートに入れる等のパターン検知）
 *   'out_of_stock'  — 品切れ（品切れ・sold out 等のパターン検知）
 *   'unknown'       — パターン不一致（ページ構造が非対応）
 *   'error'         — フェッチ失敗
 */

import { checkStockBatch } from '../lib/stock-checker.js';

/** 1 リクエストで処理するURLの上限（コスト・速度調整） */
const MAX_TARGETS = 5;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { targets } = req.body || {};

  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'targets array required' });
  }

  // バリデーション：https:// 必須・文字列のみ通す
  const safe = targets
    .filter(t => t && typeof t.url === 'string' && t.url.startsWith('https://'))
    .slice(0, MAX_TARGETS);

  if (safe.length === 0) {
    return res.status(400).json({ error: 'No valid https:// targets' });
  }

  const { results, errors } = await checkStockBatch(safe);

  return res.status(200).json({
    ok:        true,
    results,
    errors,
    checkedAt: Date.now(),
  });
}
