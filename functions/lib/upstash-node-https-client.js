/**
 * Upstash REST を node:https で叩く（global fetch / undici を使わない）。
 * Vercel サーバレスで undici が Upstash へ接続できず "fetch failed" になる場合の回避用。
 *
 * @see @upstash/redis の HttpClient.request と同等のレスポンス形 { result, error } を返す。
 */

import https from 'node:https';
import { URL } from 'node:url';
import { errors } from '@upstash/redis';

const { UpstashError, UpstashJSONParseError } = errors;

function base64decode(b64) {
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return b64;
  }
}

function decode(raw) {
  if (raw === undefined) return raw;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    return raw === 'OK' ? 'OK' : base64decode(raw);
  }
  if (Array.isArray(raw)) {
    return raw.map((v) =>
      typeof v === 'string' ? base64decode(v) : Array.isArray(v) ? v.map((e) => decode(e)) : v
    );
  }
  return raw;
}

function mergeHeaders(base, extra) {
  const out = { ...base };
  if (!extra) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function httpsPostJson(requestUrlStr, headers, bodyObj, timeoutMs) {
  let u;
  try {
    u = new URL(requestUrlStr);
  } catch (e) {
    throw new Error(`Upstash REST URL invalid (${String(requestUrlStr).slice(0, 96)}): ${e.message}`);
  }
  const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const hdrs = { ...headers, 'Content-Length': String(payload.length) };

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port:       u.port || 443,
        path:       (u.pathname || '/') + (u.search || ''),
        method:     'POST',
        family:     4,
        headers:    hdrs,
        timeout:    timeoutMs,
        servername: u.hostname,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode || 0,
            headers:    res.headers,
            rawBody,
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Upstash HTTPS timeout'));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * @param {string} baseUrlRaw
 * @param {string} tokenRaw
 * @param {{ timeoutMs?: number, maxHttpRetries?: number }} [opts]
 */
export function createUpstashNodeHttpsClient(baseUrlRaw, tokenRaw, opts = {}) {
  const baseUrl = String(baseUrlRaw || '').replace(/\/$/, '');
  const token = String(tokenRaw || '');
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxHttpRetries = opts.maxHttpRetries ?? 3;

  const client = {
    upstashSyncToken: '',
    readYourWrites:   true,
    headers:          {
      'Content-Type':     'application/json',
      Authorization:      `Bearer ${token}`,
      'Upstash-Encoding': 'base64',
    },

    mergeTelemetry(telemetry) {
      if (telemetry?.runtime) {
        client.headers['Upstash-Telemetry-Runtime'] = String(telemetry.runtime);
      }
      if (telemetry?.platform) {
        client.headers['Upstash-Telemetry-Platform'] = String(telemetry.platform);
      }
      if (telemetry?.sdk) {
        client.headers['Upstash-Telemetry-Sdk'] = String(telemetry.sdk);
      }
    },

    async request(req) {
      const pathSegments = req.path ?? [];
      const requestUrl = [baseUrl, ...pathSegments].join('/');
      const body = req.body;
      const merged = mergeHeaders(client.headers, req.headers);
      if (client.readYourWrites && client.upstashSyncToken) {
        merged['upstash-sync-token'] = client.upstashSyncToken;
      }

      let lastErr;
      for (let attempt = 0; attempt < maxHttpRetries; attempt++) {
        try {
          const res = await httpsPostJson(requestUrl, merged, body, timeoutMs);
          const sync =
            res.headers['upstash-sync-token'] ||
            res.headers['Upstash-Sync-Token'];
          if (typeof sync === 'string') {
            client.upstashSyncToken = sync;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            let parsed;
            try {
              parsed = JSON.parse(res.rawBody);
            } catch (e) {
              throw new UpstashJSONParseError(res.rawBody, { cause: e });
            }

            if (Array.isArray(parsed)) {
              return parsed.map(({ result: r, error: err }) => ({
                result: decode(r),
                error:  err,
              }));
            }
            return {
              result: decode(parsed.result),
              error:  parsed.error,
            };
          }

          let errBody;
          try {
            errBody = JSON.parse(res.rawBody);
          } catch {
            errBody = { error: res.rawBody };
          }
          throw new UpstashError(
            `${errBody.error || errBody.message || `HTTP ${res.statusCode}`}, command was: ${JSON.stringify(body)}`
          );
        } catch (e) {
          lastErr = e;
          if (attempt < maxHttpRetries - 1) {
            await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
          }
        }
      }
      throw lastErr;
    },
  };

  return client;
}
