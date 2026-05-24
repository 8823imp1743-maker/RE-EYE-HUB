/**
 * quota-manager.js — 外部API 使用前制御 ＋ 残量予測
 *
 * ── 設計原則 ──────────────────────────────────────────
 * 1. 呼び出し前チェック（quotaCheck）が唯一の防御線
 * 2. safeCall = quotaCheck → fn() → quotaConsume（成功時のみ）
 * 3. quota/rate error → 即 lock（その日は一切呼ばない）
 * 4. Redis は per-command コストが必要なため redis-guard.js に委譲
 *
 * ── 予測残量 ──────────────────────────────────────────
 *   remainingHours = remainingCalls / avgPerHour
 *   avgPerHour     = used / elapsedHours (UTC 0:00 から)
 *   avgPerHour = 0 → remainingHours = null（"∞" 表示）
 *
 * ── インスタンス分離の限界 ──────────────────────────
 * Vercel Serverless は複数インスタンスが独立したメモリを持つ。
 * カウンターはインスタンス内のみ有効。
 * 最終安全壁は外部サービス側の「$0 Budget Cap / 無料プラン上限」。
 */

export const LIMITS = {
  gemini:  Number(process.env.QUOTA_GEMINI_DAILY)  || 50,
  serpapi: Number(process.env.QUOTA_SERPAPI_DAILY)  || 80,
  cron:    Number(process.env.QUOTA_CRON_DAILY)     || 24,
};

// ── ウィンドウ管理（UTC 00:00 リセット） ──────────────

function todayUtcKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** UTC 今日の 0:00:00 の UNIX ms */
function utcMidnightMs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const state = {
  day:         todayUtcKey(),
  windowStart: utcMidnightMs(),
  counts:      Object.fromEntries(Object.keys(LIMITS).map(k => [k, 0])),
  locked:      Object.fromEntries(Object.keys(LIMITS).map(k => [k, false])),
};

function maybeReset() {
  const today = todayUtcKey();
  if (state.day !== today) {
    state.day         = today;
    state.windowStart = utcMidnightMs();
    for (const k of Object.keys(LIMITS)) {
      state.counts[k] = 0;
      state.locked[k] = false;
    }
  }
}

/** UTC 0:00 からの経過時間（時間単位、最小 0.001）*/
export function getWindowElapsedHours() {
  maybeReset();
  return Math.max(0.001, (Date.now() - state.windowStart) / 3_600_000);
}

// ── コア制御 API ──────────────────────────────────────

/**
 * 呼び出し前チェック。false なら呼び出し禁止。
 * @param {string} service  'gemini' | 'serpapi' | 'cron'
 */
export function quotaCheck(service) {
  maybeReset();
  if (process.env[`ENABLE_${service.toUpperCase()}`] === 'false') return false;
  if (state.locked[service]) return false;
  return (state.counts[service] || 0) < (LIMITS[service] ?? Infinity);
}

/**
 * 成功時のみ呼ぶ。超過時は自動 lock。
 * @param {string} service
 * @param {number} [cost]
 */
export function quotaConsume(service, cost = 1) {
  maybeReset();
  state.counts[service] = (state.counts[service] || 0) + cost;
  if (state.counts[service] >= (LIMITS[service] ?? Infinity)) {
    state.locked[service] = true;
    console.warn(`[quota] ${service} daily limit reached (${state.counts[service]}/${LIMITS[service]})`);
  }
}

/**
 * quota エラー検知時に呼ぶ。その日は以後の呼び出しを全停止。
 * @param {string} service
 */
export function quotaLock(service) {
  state.locked[service] = true;
  console.error(`[quota] ${service} LOCKED — quota error detected`);
}

/**
 * 外部API呼び出しの統一ラッパー。
 *
 * - quotaCheck → false なら fn() を呼ばず null を返す
 * - fn() 成功 → quotaConsume して result を返す
 * - fn() エラーで quota/rate 系 → quotaLock してから再 throw
 * - fn() エラーでネットワーク系 → 消費なし・re-throw のみ
 *
 * @template T
 * @param {string} service
 * @param {() => Promise<T>} fn
 * @returns {Promise<T|null>}
 */
export async function safeCall(service, fn) {
  if (!quotaCheck(service)) {
    console.warn(
      `[quota] ${service} blocked — count=${state.counts[service] || 0}/${LIMITS[service]}, locked=${state.locked[service]}`
    );
    return null;
  }
  try {
    const result = await fn();
    quotaConsume(service);
    return result;
  } catch (e) {
    const msg = String(e?.message || e);
    if (/quota|max daily|rate.?limit|429|resource.?exhausted|too many request/i.test(msg)) {
      quotaLock(service);
    }
    throw e;
  }
}

// ── ステータス＆予測 ──────────────────────────────────

/**
 * 1サービスの予測を計算する。
 * @param {string}  k          サービスキー
 * @param {number}  elapsed    経過時間（時間）
 * @returns {{used,limit,remaining,locked,ok,avgPerHour,remainingHours,pct,status}}
 */
function buildServiceStatus(k, elapsed) {
  const used      = state.counts[k] || 0;
  const limit     = LIMITS[k] ?? Infinity;
  const remaining = Math.max(0, limit - used);
  const pct       = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const avgPerHour = elapsed > 0 ? used / elapsed : 0;
  const remainingHours =
    avgPerHour > 0
      ? Math.round((remaining / avgPerHour) * 10) / 10
      : null; // null = "∞"（まだ使っていない）

  const status =
    pct >= 90 ? 'CRITICAL' :
    pct >= 70 ? 'WARNING'  :
    'SAFE';

  return {
    used,
    limit,
    remaining,
    locked:         state.locked[k],
    ok:             !state.locked[k] && used < limit,
    pct,
    avgPerHour:     Math.round(avgPerHour * 100) / 100,
    remainingHours,
    elapsedHours:   Math.round(elapsed * 10) / 10,
    status,
  };
}

/**
 * 全サービスのステータス＋予測を返す（ヘルスチェック・UI用）。
 * Redis は redis-guard.js から別途マージすること。
 *
 * @returns {Object.<string, {used,limit,remaining,locked,ok,pct,avgPerHour,remainingHours,elapsedHours,status}>}
 */
export function quotaStatus() {
  maybeReset();
  const elapsed = getWindowElapsedHours();
  return Object.fromEntries(
    Object.keys(LIMITS).map(k => [k, buildServiceStatus(k, elapsed)])
  );
}

/**
 * Redis の redisGuardStatus() 形式から統一ステータス形式に変換するヘルパー。
 * usage-status.js が import して使う。
 *
 * @param {{ count, limit, blocked, enableWrite }} rg  redis-guard.js の出力
 * @param {number} elapsed  経過時間（時間）
 */
export function buildRedisStatus(rg, elapsed) {
  const used      = rg.count || 0;
  const limit     = rg.limit || 8000;
  const remaining = Math.max(0, limit - used);
  const pct       = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const avgPerHour = elapsed > 0 ? used / elapsed : 0;
  const remainingHours =
    avgPerHour > 0 ? Math.round((remaining / avgPerHour) * 10) / 10 : null;
  const status =
    pct >= 90 ? 'CRITICAL' :
    pct >= 70 ? 'WARNING'  :
    'SAFE';

  return {
    used,
    limit,
    remaining,
    locked:         rg.blocked || !rg.enableWrite,
    ok:             !rg.blocked && rg.enableWrite && used < limit,
    pct,
    avgPerHour:     Math.round(avgPerHour * 100) / 100,
    remainingHours,
    elapsedHours:   Math.round(elapsed * 10) / 10,
    status,
  };
}
