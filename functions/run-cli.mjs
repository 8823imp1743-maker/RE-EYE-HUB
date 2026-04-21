#!/usr/bin/env node
/**
 * 単発実行 CLI（デフォルト）。処理完了後にプロセス終了。
 * 事前に functions/.env を用意し、UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN を設定。
 *
 *   node run-cli.mjs           … 在庫監視 1 サイクル（checkAllWatched）
 *   node run-cli.mjs auction   … ヤフオク相場チェック（checkAuctionPrices）
 *
 * RE_EYE_CLI=1 は動的 import より前にセットし、詳細ログ用に api/monitor.js が参照する。
 */
import 'dotenv/config';

process.env.RE_EYE_CLI = '1';

const { checkAllWatched, checkAuctionPrices } = await import('./api/monitor.js');

const cmd = process.argv[2] || 'stock-watch';

(async () => {
  try {
    if (cmd === 'auction') {
      console.log('[run-cli] ヤフオク相場チェックを開始します');
      await checkAuctionPrices();
    } else if (cmd === 'stock-watch' || cmd === 'watch') {
      console.log('[run-cli] 在庫監視 1 サイクルを開始します');
      await checkAllWatched();
    } else {
      console.error('Usage: node run-cli.mjs [stock-watch|auction]');
      process.exit(1);
    }
    console.log('[run-cli] すべての処理が完了しました');
    process.exit(0);
  } catch (e) {
    console.error('[run-cli] 失敗:', e);
    process.exit(1);
  }
})();
