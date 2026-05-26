/**
 * /api/index.js — 単一APIルーター
 *
 * Vercel Hobby プラン最大12 Functions 制限への対応。
 * このファイルが唯一の実行エンジン。
 *
 * ── ルーティング方式 ──────────────────────────────────
 * 1. /api/search?...          → search  （vercel.json rewrite 経由）
 * 2. /api/index?action=search → search  （直接 action 指定）
 *
 * ── 絶対ルール ────────────────────────────────────────
 * 新機能追加 = case 追加のみ。/api/*.js の新規作成は禁止。
 */

import { attachExpressLikeResponse, ensureJsonBody, ensureQuery } from './_compat.js';
import { guardVercelApi } from './_security.js';
import { captureIfCritical } from './_sentry.js';
import { applySearchMemoryShield } from './_search-vercel-memory.js';

// ── 内部ハンドラ（全量 import） ────────────────────────
import cronHandler         from '../functions/api/cron.js';
import monitorHandler      from '../functions/api/monitor.js';
import searchHandler       from '../functions/api/search.js';
import scoutHandler        from '../functions/api/scout.js';
import pollHandler         from '../functions/api/poll.js';
import dashboardHandler    from '../functions/api/dashboard.js';
import trendHandler        from '../functions/api/trend.js';
import userSettingsHandler from '../functions/api/user-settings.js';
import reportsHandler      from '../functions/api/reports.js';
import systemHealthHandler from '../functions/api/system-health.js';
import notifyHealthHandler from '../functions/api/notify-health.js';
import ctrClickHandler     from '../functions/api/ctr-click.js';
import usageStatusHandler  from '../functions/api/usage-status.js';
import { discoverUrlsForKeyword, buildMonitorEntries } from '../functions/lib/scout-to-monitor-bridge.js';

// ── ルート設定テーブル ────────────────────────────────
// rateTier: 'default' | 'heavy' | 'search' | null（スキップ）
// specialAuth: 'cron'（X-Cron-Secret 検証）
const ROUTES = {
  'cron':          { fn: cronHandler,          rateTier: null,      specialAuth: 'cron' },
  'monitor':       { fn: monitorHandler,       rateTier: 'heavy'  },
  'search':        { fn: searchHandler,        rateTier: 'search',  searchMemory: true },
  'scout':         { fn: scoutHandler,         rateTier: 'heavy'  },
  'poll':          { fn: pollHandler,          rateTier: 'default' },
  'dashboard':     { fn: dashboardHandler,     rateTier: 'default' },
  'trend':         { fn: trendHandler,         rateTier: 'heavy'  },
  'user-settings': { fn: userSettingsHandler,  rateTier: 'default' },
  'reports':       { fn: reportsHandler,       rateTier: 'default' },
  'system-health': { fn: systemHealthHandler,  rateTier: 'default' },
  'notify-health': { fn: notifyHealthHandler,  rateTier: 'default', noBody: true },
  'ctr-click':     { fn: ctrClickHandler,      rateTier: 'default' },
  'usage-status':  { fn: usageStatusHandler,   rateTier: null      },
  'discover':      { fn: discoverHandler,       rateTier: 'heavy'  },
};

// ── discover ハンドラ（キーワード → URL発見 → 自動登録） ──────────
async function discoverHandler(req, res) {
  const body       = req.body || {};
  const keyword    = String(body.keyword || '').trim();
  const userId     = String(body.userId  || '').trim();
  const mode       = body.mode === 'sneaker' ? 'sneaker' : 'standard';
  // autoRegister=true の場合、トップ候補を自動で monitor.js に登録する
  const autoRegister = body.autoRegister === true;

  if (!keyword || !userId) {
    return res.status(400).json({ ok: false, error: 'keyword, userId are required' });
  }

  const result  = await discoverUrlsForKeyword({ keyword, mode });
  const entries = buildMonitorEntries({
    userId,
    keyword,
    discoveredUrls: result.discoveredUrls,
    mode,
    product: result.product,
  });

  // ── 自動登録: 発見済みトップURLをmonitor.jsに直接登録 ──────────
  let autoRegistered = [];
  if (autoRegister && entries.length > 0) {
    const topEntries = entries.slice(0, 3); // 上位3件まで自動登録
    const monFn = (await import('../functions/api/monitor.js')).default;

    for (const entry of topEntries) {
      try {
        const mockReq = {
          method: 'POST',
          body: {
            keyword:  entry.keyword,
            userId:   entry.userId,
            itemId:   entry.itemId,
            sourceId: entry.sourceId,
            url:      entry.url || '',
            title:    entry.canonicalName || entry.keyword,
            mode:     entry.mode,
            category: entry.category,
          },
          headers: {},
        };
        let regOk = false;
        const mockRes = {
          statusCode: 200,
          writableEnded: false,
          setHeader: () => {},
          status(c) { this.statusCode = c; return this; },
          json(d) { regOk = d?.registered !== false; this.writableEnded = true; return this; },
          end(d)  { this.writableEnded = true; return this; },
        };
        await monFn(mockReq, mockRes);
        if (regOk) autoRegistered.push(entry.sourceId);
      } catch (e) {
        console.warn('[discover/autoRegister] failed:', e.message);
      }
    }
  }

  // ── 構造化ログ（Sentry 連携可能形式） ──────────────────────────────────
  console.log('[discover:result]', JSON.stringify({
    keyword,
    canonicalName: result.product?.canonicalName || keyword,
    category:      result.product?.category || 'standard',
    mode:          result.mode,
    source:        result.source,
    discoveredCount:  result.discoveredUrls.length,
    entriesCount:     entries.length,
    autoRegistered:   autoRegistered.length,
    topScore:         result.scored?.[0]?.score ?? 0,
    rssSignalCount:   result.rssSignals?.length ?? 0,
  }));

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    keyword,
    mode:          result.mode,
    category:      result.product?.category || 'standard',
    canonicalName: result.product?.canonicalName || keyword,
    source:        result.source,
    discoveredUrls: result.discoveredUrls,
    monitorEntries: entries,
    autoRegistered,
  });
}

// ── cron 暴走防止（インスタンス内メモリ） ────────────
let _lastCronMs = 0;
const CRON_COOLDOWN_MS = 55 * 60 * 1000; // 55分

// ── URLパスからルートキーを解決 ──────────────────────
function resolveRoute(req) {
  const rawUrl = String(req.url || '/');
  const qIdx   = rawUrl.indexOf('?');
  const path   = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const qs     = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)) : null;

  // ?action= パラメータ優先
  const action = qs?.get('action');
  if (action) return action;

  // パス末尾セグメント（/api/search → 'search'）
  const seg = path.replace(/\/$/, '').split('/').pop() || '';
  return seg !== 'index' ? seg : null;
}

export default async function handler(req, res) {
  attachExpressLikeResponse(res);
  ensureQuery(req);

  // CORS プリフライト（Firebase Hosting → Vercel のクロスオリジン対応）
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin',  'https://re-eye-hub.web.app');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Cron-Secret');
    res.statusCode = 204;
    res.end();
    return;
  }

  const route  = resolveRoute(req);
  const config = route ? ROUTES[route] : null;

  if (!config) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_ACTION',
      available: Object.keys(ROUTES),
    });
  }

  // ── cron 特別ガード ──────────────────────────────
  if (config.specialAuth === 'cron') {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    // cron 実行間隔ガード（55分未満はスキップ）
    const now = Date.now();
    if (_lastCronMs > 0 && now - _lastCronMs < CRON_COOLDOWN_MS) {
      console.log(`[router/cron] cooldown — skip (${Math.round((now - _lastCronMs) / 60000)}min ago)`);
      return res.status(200).json({ ok: true, skipped: 'RATE_LIMITED' });
    }
    _lastCronMs = now;
  }

  // ── レート制限ガード ─────────────────────────────
  if (config.rateTier) {
    const gate = await guardVercelApi(req, res, { rateTier: config.rateTier });
    if (gate !== 'ok') return;
  }

  // ── ボディパース ─────────────────────────────────
  if (!config.noBody) {
    await ensureJsonBody(req);
  }

  // ── ハンドラ実行 ─────────────────────────────────
  try {
    if (config.searchMemory) {
      return await applySearchMemoryShield(req, res, config.fn);
    }
    return await config.fn(req, res);
  } catch (e) {
    void captureIfCritical(e, { endpoint: route });
    console.error(`[api/index] route=${route}`, e?.message || e);
    if (res.writableEnded) return;

    // ルート別のフォールバックレスポンス
    const fallbacks = {
      'search':        { found: false, items: [], errors: [e?.message], sourceNote: 'rakuten_yahoo_rule_based' },
      'scout':         { ok: false, newCount: 0, items: [], errors: [e?.message] },
      'poll':          { error: e?.message, newItems: [], allItems: [], errors: [e?.message] },
      'trend':         { error: e?.message, items: [] },
      'user-settings': { error: e?.message, found: false, settings: null },
      'cron':          { error: e?.message },
    };

    const body = fallbacks[route] ?? { ok: false, error: e?.message || 'internal error' };
    res.statusCode = fallbacks[route] ? 200 : 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify(body));
  }
}
