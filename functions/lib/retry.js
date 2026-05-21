/**
 * lib/retry.js
 * 指数バックオフ付きリトライ + 429 Rate Limit 専用待機
 *
 * 使い方:
 *   const json = await withRetry(() => fetchSomething(), { label: '楽天API' });
 */

/**
 * 指数バックオフでリトライする汎用ラッパー。
 * - HTTP 429 は Retry-After ヘッダを尊重して待機
 * - 5xx はリトライ対象
 * - 4xx (429 以外) はリトライしない
 *
 * @param {() => Promise<Response>} fetchFn  fetch() を返す関数
 * @param {{ label?: string, maxRetries?: number, baseDelayMs?: number }} opts
 * @returns {Promise<any>}  JSON パース済みのレスポンスボディ
 */
export async function withRetry(fetchFn, opts = {}) {
  const { label = 'API', maxRetries = 3, baseDelayMs = 1000 } = opts;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetchFn();
    } catch (e) {
      // ネットワークエラー・Abort（タイムアウト）→ リトライ
      const msg = e?.name === 'AbortError' ? 'timeout/abort' : e.message;
      if (attempt === maxRetries) throw e;
      const wait = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] ${label} ネットワークエラー (試行${attempt}/${maxRetries}) → ${wait}ms 後リトライ: ${msg}`);
      await delay(wait);
      continue;
    }

    // 成功
    if (res.ok) {
      try {
        return await res.json();
      } catch (e) {
        throw new Error(`${label} JSON パース失敗 (status=${res.status}): ${e.message}`);
      }
    }

    // 429 Rate Limit
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
      const wait = retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
      console.warn(`[retry] ${label} 429 Rate Limit (試行${attempt}/${maxRetries}) → ${Math.round(wait / 1000)}秒 待機`);
      if (attempt === maxRetries) throw new Error(`${label} Rate Limit — リトライ上限到達`);
      await delay(wait);
      continue;
    }

    // 5xx サーバーエラー → リトライ
    if (res.status >= 500) {
      const wait = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] ${label} ${res.status} サーバーエラー (試行${attempt}/${maxRetries}) → ${wait}ms 後リトライ`);
      if (attempt === maxRetries) throw new Error(`${label} ${res.status} エラー — リトライ上限到達`);
      await delay(wait);
      continue;
    }

    // 4xx クライアントエラー（429 以外）→ リトライしない
    let body = '';
    try { body = await res.text(); } catch {}
    throw new Error(`${label} ${res.status} エラー: ${body.slice(0, 200)}`);
  }
}

/**
 * PDP 等: HTML 本文を取る fetch（JSON 以外）。429 / 5xx / ネットワークをリトライし、
 * 成功時は res.text() を返す。最終失敗は null（呼び出し側で pdp_fetch_fail 扱いにできる）。
 */
export async function withRetryHtmlFetch(fetchFn, opts = {}) {
  const { label = 'PDP-HTML', maxRetries = 3, baseDelayMs = 1000 } = opts;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetchFn();
    } catch (e) {
      const msg = e?.name === 'AbortError' ? 'timeout/abort' : e.message;
      if (attempt === maxRetries) {
        console.warn(`[retry-html] ${label} 最終失敗: ${msg}`);
        return null;
      }
      const wait = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[retry-html] ${label} ネットワーク (試行${attempt}/${maxRetries}) → ${wait}ms: ${msg}`
      );
      await delay(wait);
      continue;
    }

    if (res.ok) {
      try {
        const txt = await res.text();
        return typeof txt === 'string' ? txt : null;
      } catch (e) {
        if (attempt === maxRetries) return null;
        const wait = baseDelayMs * 2 ** (attempt - 1);
        await delay(wait);
        continue;
      }
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
      const wait = retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
      console.warn(
        `[retry-html] ${label} 429 (試行${attempt}/${maxRetries}) → 約${Math.round(wait / 1000)}秒 待機`
      );
      if (attempt === maxRetries) return null;
      await delay(wait);
      continue;
    }

    if (res.status >= 500) {
      const wait = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[retry-html] ${label} ${res.status} (試行${attempt}/${maxRetries}) → ${wait}ms`
      );
      if (attempt === maxRetries) return null;
      await delay(wait);
      continue;
    }

    // 4xx: 再試行しない
    return null;
  }
  return null;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
