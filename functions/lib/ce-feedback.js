/**
 * CE 却下の蓄積 → 次回 LLM 分類プロンプトへのフィードバック（自己改善ループ）
 * Redis 未設定・障害時は黙ってスキップ（本線を壊さない）
 */

import { getRedis, withRedisRetry } from './redis.js';

const KEY_RECENT = 'ce:fb:recent';
const KEY_FLAG_COUNTS = 'ce:fb:flagcounts';
const RECENT_CAP = 199;
const TTL_SEC = 90 * 24 * 3600;

export function ceFeedbackUrlHost(url) {
  try {
    return String(new URL(String(url || '')).hostname || '').slice(0, 120);
  } catch {
    return '';
  }
}

/**
 * @param {Record<string, string>} hgetall hincrby 累積（値は文字列）
 * @param {string[]} recentJson 先頭から新しい順の JSON 文字列
 */
export function buildCeFeedbackPromptNudgeFromData(flagCounts, recentJson) {
  const pairs = [];
  if (flagCounts && typeof flagCounts === 'object') {
    for (const [k, v] of Object.entries(flagCounts)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n > 0) pairs.push([k, n]);
    }
  }
  pairs.sort((a, b) => b[1] - a[1]);
  const top = pairs.slice(0, 6);
  if (top.length === 0 && (!recentJson || recentJson.length === 0)) return '';

  const lines = [];
  if (top.length) {
    lines.push('フラグ別累積（CE却下・本番運用）:');
    for (const [k, n] of top) {
      lines.push(`- ${k}: ${n}回`);
    }
  }
  const hints = [];
  for (let i = 0; i < Math.min(3, recentJson.length); i++) {
    try {
      const o = JSON.parse(recentJson[i]);
      const h = o.host ? String(o.host).slice(0, 48) : '';
      const fl = Array.isArray(o.flags) ? o.flags.slice(0, 3).join(',') : '';
      if (fl) hints.push(h ? `${fl}@${h}` : fl);
    } catch {
      /* skip */
    }
  }
  if (hints.length) {
    lines.push(`直近サンプル傾向: ${hints.join(' / ')}`);
  }
  lines.push(
    '上記は「過去に PDP または最終採用と矛盾した」蓄積である。該当しそうな行は confidence を抑え、gender と product_role を厳密に。断定は禁止。',
  );
  const body = lines.join('\n');
  if (body.length > 900) return `${body.slice(0, 897)}…`;
  return body;
}

export async function getCeFeedbackPromptNudge() {
  try {
    const r = getRedis();
    const counts = await withRedisRetry(() => r.hgetall(KEY_FLAG_COUNTS), { label: 'ce-fb-hgetall' });
    const recent = await withRedisRetry(() => r.lrange(KEY_RECENT, 0, 4), { label: 'ce-fb-lrange' });
    const arr = Array.isArray(recent) ? recent.map((x) => String(x || '')) : [];
    return buildCeFeedbackPromptNudgeFromData(counts || {}, arr);
  } catch {
    return '';
  }
}

/**
 * @param {{ source?: string, flags?: string[], reason?: string, keyword?: string, urlHost?: string }} payload
 */
export async function recordCeRejectionSafe(payload) {
  const flags = Array.isArray(payload?.flags) ? payload.flags.filter(Boolean) : [];
  const reason = String(payload?.reason || '').trim();
  if (flags.length === 0 && !reason) return;

  const entry = JSON.stringify({
    t: Date.now(),
    flags,
    reason: reason.slice(0, 220),
    kw: String(payload?.keyword || '').slice(0, 100),
    host: String(payload?.urlHost || '').slice(0, 120),
    source: String(payload?.source || 'unknown').slice(0, 40),
  });

  try {
    await withRedisRetry(async () => {
      const r = getRedis();
      await r.lpush(KEY_RECENT, entry);
      await r.ltrim(KEY_RECENT, 0, RECENT_CAP);
      for (let i = 0; i < flags.length; i++) {
        await r.hincrby(KEY_FLAG_COUNTS, flags[i], 1);
      }
      if (flags.length === 0 && reason) {
        await r.hincrby(KEY_FLAG_COUNTS, '_reason_only', 1);
      }
      await r.expire(KEY_FLAG_COUNTS, TTL_SEC);
      await r.expire(KEY_RECENT, TTL_SEC);
    }, { label: 'ce-fb-record' });
  } catch (e) {
    console.warn('[ce-feedback] record skip:', String(e?.message || e).slice(0, 120));
  }
}
