/**
 * 外部ショップ API 向け fetch — タイムアウト・User-Agent 付き
 * （Vercel / Cloud Functions での無限待ち・fetch failed を減らす）
 */

const DEFAULT_UA = 'RE-EYE-HUB/1.0 (+https://re-eye-hub.web.app)';

/**
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]  既定 14s（楽天・Yahoo の応答待ち上限）
 */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 14000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': DEFAULT_UA,
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}
