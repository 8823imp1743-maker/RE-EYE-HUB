/**
 * 在庫復活・品切れ監視エンジン
 *
 * ショップページを直接フェッチし、在庫状況パターンを検知する。
 * スクレイピング基盤として各ショップの共通パターンを収録。
 *
 * 使用例（api/stock.js から呼ぶ）:
 *   const { results } = await checkStockBatch([
 *     { url: 'https://www.amazon.co.jp/dp/XXXXX', keyword: 'ポケモン' }
 *   ]);
 */

import { stealthHeaders } from './stealth.js';

// ── 在庫あり判定パターン（各ショップ共通） ──────────────────────────
const IN_STOCK_PATTERNS = [
  /カートに入れる/,
  /今すぐ購入/,
  /Add to Cart/i,
  /在庫あり/,
  /残り\d+点/,
  /in stock/i,
  /ご注文はこちら/,
  /購入する/,
];

// ── 品切れ・販売終了判定パターン ────────────────────────────────────
const OUT_OF_STOCK_PATTERNS = [
  /現在在庫切れ/,
  /品切れ/,
  /sold out/i,
  /販売終了/,
  /入荷待ち/,
  /Currently unavailable/i,
  /取り扱いを終了/,
];

/**
 * 単一 URL の在庫状況を確認する。
 *
 * @param {string} url      チェック対象の URL（https:// 必須）
 * @param {string} keyword  ステルスヘッダー生成用キーワード
 * @returns {Promise<StockResult>}
 */
export async function checkStock(url, keyword = '') {
  try {
    const res = await fetch(url, {
      headers: {
        ...stealthHeaders(keyword),
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      signal: AbortSignal.timeout(10000), // 10 秒タイムアウト
    });

    if (!res.ok) return { status: 'unknown', url, httpStatus: res.status };

    const html = await res.text();

    if (OUT_OF_STOCK_PATTERNS.some(re => re.test(html))) {
      return { status: 'out_of_stock', url };
    }
    if (IN_STOCK_PATTERNS.some(re => re.test(html))) {
      return { status: 'in_stock', url };
    }
    return { status: 'unknown', url };
  } catch (e) {
    return { status: 'error', url, error: e.message };
  }
}

/**
 * 複数 URL を並列チェックして結果を集約する。
 *
 * @param {{ url: string, keyword?: string }[]} targets
 * @returns {Promise<{ results: StockResult[], errors: string[] }>}
 */
export async function checkStockBatch(targets) {
  const settled = await Promise.allSettled(
    targets.map(t => checkStock(t.url, t.keyword || ''))
  );

  const results = [];
  const errors  = [];

  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      results.push(r.value);
    } else {
      errors.push(`[${targets[i].url}] ${r.reason?.message || 'Unknown error'}`);
    }
  });

  return { results, errors };
}

/**
 * @typedef {Object} StockResult
 * @property {'in_stock' | 'out_of_stock' | 'unknown' | 'error'} status
 * @property {string} url
 * @property {number} [httpStatus]
 * @property {string} [error]
 */
