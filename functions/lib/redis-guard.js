/**
 * Upstash Redis コマンド予算ガード
 *
 * 設計方針:
 *  - Vercel インスタンス内メモリでコマンド数を日次カウント
 *  - UPSTASH_MAX_DAILY_CMDS（デフォルト 8000）を超えたら以後の
 *    Redis 書き込みをブロックし、課金ゾーン（10,000超）に入らせない
 *  - 読み取り専用操作は別枠で寛容に扱う（ENABLE_REDIS_READ_OVER_LIMIT=1 で解除可）
 *  - env ENABLE_REDIS_WRITE=false で全 Redis 書き込みを即時停止
 *
 * ── なぜインスタンス内メモリか ──
 *  Redis カウンターで Redis 上限を管理すると循環問題が発生する。
 *  Vercel Serverless は 1リクエスト=1インスタンス（cold or warm）のため、
 *  インスタンスごとのカウンターをグローバルに保持し合算はしない。
 *  これは完璧ではないが（複数インスタンス並走時に合算できない）、
 *  単一ユーザー・低頻度運用では実用上十分な安全網になる。
 *  ダッシュボード側上限（Upstash の Max Daily Budget = $0）が最後の砦。
 */

const MAX_DAILY_CMDS = Number(process.env.UPSTASH_MAX_DAILY_CMDS) || 8000;

function todayUtcStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

const state = {
  date: todayUtcStamp(),
  count: 0,
  blocked: false,
};

function resetIfNewDay() {
  const today = todayUtcStamp();
  if (state.date !== today) {
    state.date = today;
    state.count = 0;
    state.blocked = false;
  }
}

/**
 * Redis 書き込み操作を実行する前に呼ぶ。
 * @param {string} label  ログ用ラベル
 * @param {number} [cost] このオペレーションで消費するコマンド数（デフォルト 1）
 * @returns {boolean} true = 実行OK / false = 予算超過でスキップ
 */
export function guardRedisWrite(label = 'write', cost = 1) {
  if (process.env.ENABLE_REDIS_WRITE === 'false') {
    console.warn(`[redis-guard] ENABLE_REDIS_WRITE=false: skip ${label}`);
    return false;
  }
  resetIfNewDay();
  if (state.blocked) {
    console.warn(`[redis-guard] daily limit blocked: skip ${label} (count=${state.count}/${MAX_DAILY_CMDS})`);
    return false;
  }
  state.count += cost;
  if (state.count >= MAX_DAILY_CMDS) {
    state.blocked = true;
    console.error(`[redis-guard] ⚠️ DAILY LIMIT REACHED (${state.count}/${MAX_DAILY_CMDS}): 以後の Redis 書き込みをブロック。Upstash 課金圏外を維持。`);
    return false;
  }
  return true;
}

/**
 * 現在のコマンド使用状況を返す（ヘルスチェック用）
 */
export function redisGuardStatus() {
  resetIfNewDay();
  return {
    date: state.date,
    count: state.count,
    limit: MAX_DAILY_CMDS,
    blocked: state.blocked,
    enableWrite: process.env.ENABLE_REDIS_WRITE !== 'false',
  };
}
