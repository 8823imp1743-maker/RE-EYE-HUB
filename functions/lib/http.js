import { request as httpsRequest } from 'https';
import { createGunzip, createInflate } from 'zlib';

/**
 * HTTPS リクエスト（gzip/deflate 展開、リダイレクト追跡、最終URL返却）
 *
 * @param {string} urlStr
 * @param {{ method?: 'GET'|'HEAD', headers?: Record<string,string>, timeoutMs?: number, maxRedirects?: number }} [opt]
 * @returns {Promise<{ statusCode: number, headers: Record<string, any>, body: string, finalUrl: string }>}
 */
export function httpsFetch(urlStr, opt = {}) {
  const method = opt.method || 'GET';
  const headers = opt.headers || {};
  const timeoutMs = Number(opt.timeoutMs || 15000);
  const maxRedirects = Number(opt.maxRedirects ?? 5);

  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        'Accept-Encoding': 'gzip, deflate',
        Connection: 'close',
      },
      timeout: timeoutMs,
    };

    const req = httpsRequest(options, (res) => {
      // Redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const location = new URL(res.headers.location, urlStr).href;
        res.resume();
        return resolve(
          httpsFetch(location, { ...opt, maxRedirects: maxRedirects - 1, method: opt.method || 'GET' })
        );
      }

      const statusCode = res.statusCode || 0;
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      const chunks = [];

      const done = () => resolve({
        statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
        finalUrl: urlStr,
      });

      if (method === 'HEAD') {
        res.resume();
        return resolve({ statusCode, headers: res.headers, body: '', finalUrl: urlStr });
      }

      if (encoding === 'gzip') {
        const gunzip = createGunzip();
        res.pipe(gunzip);
        gunzip.on('data', c => chunks.push(c));
        gunzip.on('end', done);
        gunzip.on('error', reject);
      } else if (encoding === 'deflate') {
        const inflate = createInflate();
        res.pipe(inflate);
        inflate.on('data', c => chunks.push(c));
        inflate.on('end', done);
        inflate.on('error', reject);
      } else {
        res.on('data', c => chunks.push(Buffer.from(c)));
        res.on('end', done);
        res.on('error', reject);
      }
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

