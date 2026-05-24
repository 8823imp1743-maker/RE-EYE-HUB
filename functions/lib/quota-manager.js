/**
 * quota-manager.js — 外部API 使用前制御の中央管理
 *
 * ── 設計原則 ──────────────────────────────────────────
 * 1. 呼び出し前チェック（quotaCheck）が唯一の防御線
 * 2. safeCall = quotaCheck → fn() → quotaConsume（成功時のみ）
 * 3. quota/rate error → 即 lock（その日は一切呼ばない）
 * 4. Redis は per-command コストが必要なため redis-guard.js に委譲
 *
 * ── インスタンス分離の限界 ──────────────────────────
 * Vercel Serverless は複数インスタンスが独立したメモリを持つ。
 * このカウンターはインスタンス内のみ有効。
 * 最終安全壁は外部サービス側の「無料プラン上限」または「$0 Budget Cap」。
 */

const LIMITS = {
  gemini:  Number(process.env.QUOTA_GEMINI_DAILY)  || 50,
  serpapi: Number(process.env.QUOTA_SERPAPI_DAILY)  || 80,
  cron:    Number(process.env.QUOTA_CRON_DAILY)     || 24,
};

function todayUtcKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

const state = {
  day: todayUtcKey(),
  counts: Object.fromEntries(Object.keys(LIMITS).map(k => [k, 0])),
  locked: Object.fromEntries(Object.keys(LIMITS).map(k => [k, false])),
};

function maybeReset() {
  const today = todayUtcKey();
  if (state.day !== today) {
    state.day = today;
    for (const k of Object.keys(LIMITS)) {
      state.counts[k] = 0;
      state.locked[k] = false;
    }
  }
}

/**
 * 呼び出し前チェック。false なら呼び出し禁止。
 * @param {string} service  'gemini' | 'serpapi' | 'cron'
 */
export function quotaCheck(service) {
  maybeReset();
  // env オーバーライド: ENABLE_GEMINI=false 等で即停止
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

/**
 * ヘルスチェック用ステータス。redis-guard.js と並べて /api/system-health に公開。
 */
export function quotaStatus() {
  maybeReset();
  return Object.fromEntries(
    Object.keys(LIMITS).map(k => [k, {
      count:  state.counts[k] || 0,
      limit:  LIMITS[k],
      locked: state.locked[k],
      ok:     !state.locked[k] && (state.counts[k] || 0) < LIMITS[k],
    }])
  );
}
