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
const { getRedis } = await import('./lib/redis.js');

const cmd = process.argv[2] || 'stock-watch';

/** プロセスロックキー。コマンド別に独立させ auction と stock-watch が互いをブロックしない */
const LOCK_KEY = `lock:run-cli:${cmd}`;
/** ロック TTL（秒）: この時間内に処理が終わらなければ自動解放 */
const LOCK_TTL_SEC = 600; // 10分

(async () => {
  const r = getRedis();

  // ── プロセス排他ロック取得 ────────────────────────────────────────────────
  let lockAcquired = false;
  try {
    const acquired = await r.set(LOCK_KEY, '1', { nx: true, ex: LOCK_TTL_SEC });
    if (acquired === null) {
      console.log(`[run-cli] 前回の ${cmd} がまだ実行中のため、重複起動を回避して終了します。`);
      process.exit(0); // ← ロック未取得なので DEL は呼ばない（正しい）
    }
    lockAcquired = true;
  } catch (e) {
    // Redis 障害時はロックなしで続行（監視を止めない）
    console.warn('[run-cli] プロセスロック取得失敗（Redis 障害）— ロックなしで続行します:', e.message);
  }

  // ── メイン処理 ──────────────────────────────────────────────────────────
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
  } catch (e) {
    console.error('[run-cli] 失敗:', e);
  } finally {
    // ── ロック解放（正常・例外どちらの経路でも必ず実行）────────────────────
    if (lockAcquired) {
      try {
        await r.del(LOCK_KEY);
        console.log('[run-cli] 実行ロックを正常に解放しました。');
      } catch (redisErr) {
        console.error('[run-cli] ロック解放失敗（TTL 10分による自動消滅を待ちます）:', redisErr.message);
      }
    }
    process.exit(0);
  }
})();
