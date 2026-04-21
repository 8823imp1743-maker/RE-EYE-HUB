import { parse as parseUrl } from 'node:url';

/**
 * Vercel（Node 素の ServerResponse）と Firebase Functions（Express）の両方で
 * `res.status(code).json(obj)` が動くようにする。
 * Express 由来の res には既に .status があるため何もしない。
 */

/**
 * @param {import('http').ServerResponse} res
 * @returns {import('http').ServerResponse}
 */
export function attachExpressLikeResponse(res) {
  if (!res || typeof res.status === 'function') return res;

  res.status = function status(code) {
    res.statusCode = code;
    return {
      json(body) {
        if (res.writableEnded) return;
        if (!res.getHeader('Content-Type')) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
        }
        res.end(JSON.stringify(body));
      },
    };
  };
  return res;
}

/**
 * Vercel では POST の JSON が未パースのことがある。ストリームから読み取り req.body に代入する。
 * @param {import('http').IncomingMessage} req
 */
export async function ensureJsonBody(req) {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH' && req.method !== 'DELETE') return;

  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return;

  if (typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      req.body = {};
    }
    return;
  }

  if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return;
  }

  if (Buffer.isBuffer(req.body)) {
    try {
      req.body = JSON.parse(req.body.toString('utf8'));
    } catch {
      req.body = {};
    }
    return;
  }

  const raw = await readBodyBuffer(req);
  if (!raw.length) {
    req.body = {};
    return;
  }
  try {
    req.body = JSON.parse(raw.toString('utf8'));
  } catch {
    req.body = {};
  }
}

/**
 * Express は req.query を付与するが、素の IncomingMessage には無い。
 * @param {import('http').IncomingMessage} req
 */
export function ensureQuery(req) {
  if (req.query != null && typeof req.query === 'object') return;
  const path = req.url || '';
  req.query = parseUrl(path, true).query || {};
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)));
    req.on('error', reject);
  });
}
