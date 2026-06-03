/**
 * cron 認証（GH Actions X-Cron-Secret / Vercel Bearer 両対応）
 * 改行・前後空白は trim して比較（GitHub Secrets の末尾改行対策）
 */

function trimSecret(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * @param {import('http').IncomingMessage | { headers?: Record<string, string> }} req
 * @returns {{ ok: boolean, method: 'bearer'|'x-cron-secret'|null, envSecretLen: number, headerSecretLen: number, bearerOk: boolean, xSecretOk: boolean }}
 */
export function verifyCronAuth(req) {
  const secret = trimSecret(process.env.CRON_SECRET);
  const headers = req.headers || {};
  const authHeader = trimSecret(headers.authorization || headers.Authorization || '');
  const xCronSecret = trimSecret(headers['x-cron-secret'] || headers['X-Cron-Secret'] || '');

  const bearerOk = !!secret && authHeader === `Bearer ${secret}`;
  const xSecretOk = !!secret && xCronSecret === secret;
  const ok = bearerOk || xSecretOk;

  return {
    ok,
    method: bearerOk ? 'bearer' : xSecretOk ? 'x-cron-secret' : null,
    envSecretLen: secret.length,
    headerSecretLen: xCronSecret.length || (authHeader.startsWith('Bearer ') ? authHeader.slice(7).length : 0),
    bearerOk,
    xSecretOk,
  };
}

/**
 * @param {import('http').IncomingMessage | { headers?: Record<string, string> }} req
 * @returns {boolean}
 */
export function cronAuthOk(req) {
  return verifyCronAuth(req).ok;
}
