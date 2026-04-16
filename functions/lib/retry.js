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
      // ネットワークエラー → リトライ
      if (attempt === maxRetries) throw e;
      const wait = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] ${label} ネットワークエラー (試行${attempt}/${maxRetries}) → ${wait}ms 後リトライ: ${e.message}`);
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

const delay = ms => new Promise(r => setTimeout(r, ms));
