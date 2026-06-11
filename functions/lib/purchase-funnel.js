/**
 * Phase3-A: 購入成功率ファネル（通知 → クリック → 商品到達）
 * v1.0 完成ライン — 購入完了計測・BigQuery は対象外
 */

import { createHash } from 'crypto';
import { withRedisRetry } from './redis.js';
import { opsJsonLog } from './notify-ops-log.js';

const FUNNEL_TTL_SEC = 86400 * 120;
const FUNNEL_IDS_KEY = 'funnel:ids';

function funnelStageKey(stage, funnelId) {
  const id = String(funnelId || '').trim().slice(0, 32);
  const st = String(stage || '').trim();
  if (!id || !['sent', 'click', 'arrival'].includes(st)) return null;
  return `funnel:${st}:${id}`;
}

/**
 * 通知1件ごとの funnelId（16 hex）
 * @param {{ userId?: string, model?: string, color?: string, size?: string, opsSource?: string, notifyAt?: number }} meta
 */
export function buildFunnelId(meta = {}) {
  const seed = [
    String(meta.userId || '').slice(0, 48),
    String(meta.model || '').slice(0, 32),
    String(meta.color || '').slice(0, 24),
    String(meta.size || '').slice(0, 16),
    String(meta.opsSource || 'unknown').slice(0, 32),
    String(meta.notifyAt || Date.now()),
  ].join('|');
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/**
 * 監視 entry から通知 data 用ファネル payload
 * @param {object} entry
 * @param {string} userId
 * @param {string} opsSource
 */
export function buildFunnelPayloadFromEntry(entry, userId, opsSource) {
  const ta = entry?.targetAttributes && typeof entry.targetAttributes === 'object' ? entry.targetAttributes : {};
  const notifyAt = Date.now();
  const model = ta.model || (entry?.modelNumbers && entry.modelNumbers[0]) || null;
  const color = ta.color || (entry?.colorKeywords && entry.colorKeywords[0]) || null;
  const size = ta.size || null;
  const funnelId = buildFunnelId({ userId, model, color, size, opsSource, notifyAt });
  return {
    funnelId,
    funnelModel: model,
    funnelColor: color,
    funnelSize: size,
    funnelOpsSource: opsSource,
    funnelNotifyAt: notifyAt,
  };
}

/**
 * キーワードのみの簡易ファネル（poll / digest 用）
 */
export function buildFunnelPayloadFromKeyword(keyword, userId, opsSource) {
  const notifyAt = Date.now();
  const funnelId = buildFunnelId({
    userId,
    model: '',
    color: '',
    size: '',
    opsSource,
    notifyAt,
  });
  return {
    funnelId,
    funnelKeyword: String(keyword || '').slice(0, 80),
    funnelOpsSource: opsSource,
    funnelNotifyAt: notifyAt,
  };
}

/**
 * @param {import('@upstash/redis').Redis} r
 * @param {string} funnelId
 * @param {'sent'|'click'|'arrival'} stage
 * @param {Record<string, unknown>} [meta]
 */
export async function recordFunnelStage(r, funnelId, stage, meta = {}) {
  const key = funnelStageKey(stage, funnelId);
  if (!key) return 0;

  let count = 0;
  try {
    count = await withRedisRetry(() => r.incr(key), { label: `funnel-${stage}-incr` });
    if (count === 1) {
      await withRedisRetry(() => r.expire(key, FUNNEL_TTL_SEC), { label: `funnel-${stage}-exp` });
      if (stage === 'sent') {
        await withRedisRetry(() => r.sadd(FUNNEL_IDS_KEY, funnelId), { label: 'funnel-ids-sadd' });
        await withRedisRetry(() => r.expire(FUNNEL_IDS_KEY, FUNNEL_TTL_SEC), { label: 'funnel-ids-exp' });
        const metaKey = `funnel:meta:${funnelId}`;
        await withRedisRetry(
          () =>
            r.set(
              metaKey,
              JSON.stringify({
                createdAt: Date.now(),
                model: meta.model ?? null,
                color: meta.color ?? null,
                size: meta.size ?? null,
                opsSource: meta.opsSource ?? null,
                userId: meta.userId ? String(meta.userId).slice(0, 24) : null,
              }),
              { ex: FUNNEL_TTL_SEC }
            ),
          { label: 'funnel-meta-set' }
        );
      }
    }
  } catch {
    return 0;
  }

  opsJsonLog('purchase_funnel', {
    stage,
    funnelId,
    count,
    opsSource: meta.opsSource,
    model: meta.model,
    color: meta.color,
    size: meta.size,
    userId: meta.userId ? String(meta.userId).slice(0, 10) : undefined,
  });

  return count;
}

export async function funnelIdIsRegistered(r, funnelId) {
  try {
    const n = await withRedisRetry(() => r.sismember(FUNNEL_IDS_KEY, funnelId), {
      label: 'funnel-ids-check',
    });
    return !!n;
  } catch {
    return false;
  }
}

function safeRatio(num, den) {
  if (!den || den <= 0) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/**
 * @param {import('@upstash/redis').Redis} r
 * @param {{ limit?: number }} [opts]
 */
export async function buildFunnelStats(r, opts = {}) {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(opts.limit) || 50)));
  let ids = [];
  try {
    const all = await withRedisRetry(() => r.smembers(FUNNEL_IDS_KEY), { label: 'funnel-ids-sm' });
    ids = (Array.isArray(all) ? all : []).slice(-limit);
  } catch {
    ids = [];
  }

  let totalSent = 0;
  let totalClick = 0;
  let totalArrival = 0;
  const funnels = [];

  for (const fid of ids) {
    const id = String(fid).slice(0, 32);
    let sent = 0;
    let click = 0;
    let arrival = 0;
    let meta = null;
    try {
      const [s, c, a, m] = await Promise.all([
        withRedisRetry(() => r.get(funnelStageKey('sent', id)), { label: 'funnel-stat-sent' }),
        withRedisRetry(() => r.get(funnelStageKey('click', id)), { label: 'funnel-stat-click' }),
        withRedisRetry(() => r.get(funnelStageKey('arrival', id)), { label: 'funnel-stat-arrival' }),
        withRedisRetry(() => r.get(`funnel:meta:${id}`), { label: 'funnel-stat-meta' }),
      ]);
      sent = Number(s || 0) || 0;
      click = Number(c || 0) || 0;
      arrival = Number(a || 0) || 0;
      if (m) {
        try {
          meta = JSON.parse(m);
        } catch {
          meta = null;
        }
      }
    } catch {
      /* skip row */
    }

    totalSent += sent;
    totalClick += click;
    totalArrival += arrival;

    funnels.push({
      funnelId: id,
      sent,
      click,
      arrival,
      ctr: safeRatio(click, sent),
      arrivalRate: safeRatio(arrival, sent),
      clickToArrival: safeRatio(arrival, click),
      meta,
    });
  }

  return {
    totals: {
      sent: totalSent,
      click: totalClick,
      arrival: totalArrival,
      ctr: safeRatio(totalClick, totalSent),
      arrivalRate: safeRatio(totalArrival, totalSent),
      clickToArrival: safeRatio(totalArrival, totalClick),
      clickDropoff: safeRatio(totalClick > 0 ? totalClick - totalArrival : 0, totalClick),
    },
    funnelCount: funnels.length,
    funnels: funnels.sort((a, b) => (b.sent || 0) - (a.sent || 0)),
    generatedAt: Date.now(),
  };
}
