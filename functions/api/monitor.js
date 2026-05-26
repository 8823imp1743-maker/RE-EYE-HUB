/**
 * POST /api/monitor  — 見守りアイテム登録
 * GET  /api/monitor  — ユーザーの見守りアイテムのステータス一覧取得
 *
 * 在庫チェックはこのファイルの checkAllWatched() を
 * index.js のスケジューラーから呼び出す。
 */

import { getRedis, withRedisRetry } from '../lib/redis.js';
import { guardRedisWrite, redisGuardStatus } from '../lib/redis-guard.js';
import { quotaCheck, quotaConsume, quotaStatus } from '../lib/quota-manager.js';
import { analyzeNoise } from '../lib/noise-filter.js';
import { extractModelNumbers, extractSizeFromKeyword } from '../lib/cross-validator.js';
import { extractColorKeywords } from '../lib/color-filter.js';
import { searchAllCached } from '../lib/shop-search-cache.js';
import { loadUserSettings } from '../lib/user-size.js';
import { sanitizeUserId } from '../lib/user-settings.js';
import { browseCacheKey } from '../lib/serp-product-classifier.js';
import {
  userGenderForSerpV5,
  classifyAndScoreSerpItemsV5,
  resolveSerpV5PdpTask,
  runSerpV5PdpVerify,
  buildSerpFilterAdoptedList,
  isSerpV5PdpDomStructuralOn,
  isSerpV5FinalStockOn,
  serpV5AnchorProgramMatch,
  buildSerpV5OfficialUrlPdpTask,
} from '../lib/serp-v5-pipeline.js';
import { evaluateContradictionEngine } from '../lib/contradiction-engine.js';
import { recordCeRejectionSafe, ceFeedbackUrlHost } from '../lib/ce-feedback.js';
import { sendOneSignalNotification } from '../lib/notification.js';
import { checkNegativeSignal } from '../lib/url-normalizer.js';
import { shoeProfileAllowsListing } from '../lib/shoe-size-gate.js';
import { normalizeRakutenUrl } from '../lib/pdp-shoe-stock.js';
import {
  listingCmFromSizeInfo,
  sizeTagKeysForListingTolerance,
} from '../lib/size-bucket-tags.js';
import {
  allowUserPushPerMinute,
  allowUserPushPer5Min,
  allowUserPushPerDay,
} from '../lib/push-rate-limit.js';
import { enqueueDigestItem } from '../lib/digest.js';
import { opsJsonLog } from '../lib/notify-ops-log.js';

/** fetch 失敗等 retryable PDP はログのみ（キュー・リトライ用 Redis フラグは持たない） */
function scheduleRetry(item, meta = {}) {
  opsJsonLog('scheduleRetry', {
    ...meta,
    url: String(item?.url || '').slice(0, 120),
  });
}
import {
  digestPathForPlan,
  coercePlanTier,
  isPaidPlan,
} from '../lib/notify-plan-policy.js';
import { getTimeScoreJst, getJstHour } from '../lib/notify-time-jst.js';
import { computeCtrBoostScore } from '../lib/notify-ctr-boost.js';
import { allowFreePushMinGap } from '../lib/notify-min-gap.js';
import { computeHeatSignals } from '../lib/notify-heat.js';
import { ctrVariant, buildStockMonitorCtr } from '../lib/notify-ctr.js';
import { computeLtqScore, shouldSkipLtqFree } from '../lib/notify-ltv.js';
import { freeDailyCapPreSend } from '../lib/free-user-daily-cap.js';
import { getAuctionMinPrice } from '../lib/auction-checker.js';
import { getStockInterval, getStockIntervalForPlan, getAdaptiveIntervalMultiplier, CURRENT_PLAN, STOCK_CONFIG } from '../lib/plan-config.js';
import {
  MONITOR_SCHEMA_VERSION,
  WATCH_TTL,
  GLOBAL_MONITOR_KEYS_SET,
  GLOBAL_MONITOR_KEYS_SET_TTL_SEC,
  watchKey,
  userWatchIndexKey,
  userPlanKey,
  notifySentDedupeKey,
  itemHashKey,
  parseMonitorEntriesFromMget,
  isMonitorEntryRedisKey,
  monitorEntryKeysGlobPattern,
  monitorUserEntryKeysPattern,
} from '../lib/monitor-constants.js';

const PLAN_STOCK_LIMIT = {
  FREE: 3,
  STANDARD: 5,
  PRO: 10,
  VIP: 10,
};

function normalizePlan(p) {
  const v = String(p || '').trim().toUpperCase();
  return PLAN_STOCK_LIMIT[v] ? v : null;
}

async function resolveUserPlanForLimits(r, userId, requestPlan) {
  const rp = normalizePlan(requestPlan);
  if (rp) return rp;
  try {
    const raw = await r.get(userPlanKey(userId));
    const p = normalizePlan(raw);
    return p || 'FREE';
  } catch {
    return 'FREE';
  }
}

/** 通知スコープ用プラン（登録値が無ければ FREE） */
async function resolveNotifyPlan(r, userId) {
  try {
    const raw = await r.get(userPlanKey(userId));
    return coercePlanTier(raw);
  } catch {
    return 'FREE';
  }
}

/** node run-cli.mjs からのみ詳細進捗ログ（動的 import 前に RE_EYE_CLI=1 をセット） */
function isRunCli() {
  return process.env.RE_EYE_CLI === '1' || process.env.RE_EYE_CLI === 'true';
}
function cliLog(...args) {
  if (isRunCli()) console.log(...args);
}

async function allowMonitorUserPushBurst(r, userId) {
  const ok1 = await allowUserPushPerMinute(r, userId, { label: 'monitor-push-u1m' });
  if (!ok1) return false;
  const ok5 = await allowUserPushPer5Min(r, userId, { label: 'monitor-push-u5m' });
  if (!ok5) return false;
  const okd = await allowUserPushPerDay(r, userId, { label: 'monitor-push-u1d' });
  if (!okd) return false;
  return true;
}

/** SERP→PDP 状態マップのキー（楽天アフィなどは PDP と同一の正規化 URL） */
function monitorSerpDomUrlKey(url) {
  const n = normalizeRakutenUrl(url);
  const s = n && String(n).trim() ? String(n) : String(url || '').trim();
  return s;
}

function shoeSizeTagKeysFromKeywordSizeInfo(sizeInfo) {
  if (!sizeInfo || sizeInfo.type !== 'shoe') return undefined;
  const lcm = listingCmFromSizeInfo(sizeInfo);
  if (lcm == null) return undefined;
  const keys = sizeTagKeysForListingTolerance(lcm);
  return keys.length ? keys : undefined;
}

async function sendMonitorDigest(r, payload) {
  const { target, stamp, items } = payload;
  if (!Array.isArray(items) || items.length === 0) return;
  const top = items[0] || {};
  const count = items.length;
  const title =
    top.displayTitle ||
    `[まとめ通知] 新着 ${count}件`;
  const head =
    top.displayMessage ||
    `${(top.title || top.itemTitle || top.keyword || '新着').toString().slice(0, 110)}` +
      (count > 1 ? ` ほか${count - 1}件` : '');
  const url = top.url || top.itemUrl || top.link || '';
  const sizeTagKeys = Array.isArray(top.sizeTagKeys) ? top.sizeTagKeys : undefined;
  const opsPlan = typeof top.opsPlan === 'string' ? top.opsPlan : 'FREE';

  // digest 送信もレート制限に含める（送信回数を抑制）
  const burstOk = await allowMonitorUserPushBurst(r, target);
  if (!burstOk) {
    opsJsonLog('rate_limit_skip', {
      source: 'digest_flush',
      userId: String(target).slice(0, 10),
    });
    return;
  }

  const tmpl =
    typeof top.ctrTemplate === 'string'
      ? top.ctrTemplate
      : count > 1
        ? 'digest_multi'
        : 'digest_single';

  await sendOneSignalNotification({
    title,
    message: head,
    url,
    data: {
      type: 'digest',
      userId: target,
      digestStamp: stamp,
      digestCount: count,
      ctrTemplate: tmpl,
      opsPlan,
      opsSource: 'monitor_digest',
      ...(sizeTagKeys ? { sizeTagKeys } : {}),
    },
  });
}

// ── 公式ドメイン一覧（特権パス対象） ──────────────────────────────────────────
// 公式サイトが「在庫あり」と言えば他の全フィルターをスキップして即通知する。
// 「公式のカッコつけた色名（Celeste / Midnight 等）は公式が正義」
const OFFICIAL_DOMAINS = [
  'nike.com', 'adidas.com', 'coach.com', 'puma.com', 'newbalance.com',
  'underarmour.com', 'vans.com', 'converse.com', 'reebok.com', 'asics.com',
  'uniqlo.com', 'zara.com', 'hm.com', 'gap.co.jp', 'gap.com',
  'louisvuitton.com', 'gucci.com', 'hermes.com', 'chanel.com', 'coach.com',
  'pokemon.co.jp', 'nintendo.com', 'bandai.co.jp',
  'abc-mart.net', 'abc-mart.com', 'atmos-tokyo.com',
  'shopjp.lululemon.com', 'lululemon.com',
];

/**
 * URL が公式ドメインか判定する。
 * @param {string} url
 * @returns {boolean}
 */
function isOfficialUrl(url) {
  if (!url || !url.startsWith('https://')) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return OFFICIAL_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch { return false; }
}

/**
 * 全監視エントリのキー一覧（SMEMBERS 優先。空なら KEYS 一回で移行してセットを埋める）
 */
async function fetchAllMonitorEntryKeys(r) {
  let keys = await withRedisRetry(() => r.smembers(GLOBAL_MONITOR_KEYS_SET), { label: 'watch:global-smembers' }).catch(
    () => []
  );
  if (!Array.isArray(keys)) keys = [];
  keys = keys.filter(isMonitorEntryRedisKey);
  if (keys.length > 0) return keys;

  const raw = await withRedisRetry(() => r.keys(monitorEntryKeysGlobPattern()), { label: 'watch:keys-migrate' }).catch(
    () => []
  );
  const filtered = (raw || []).filter(isMonitorEntryRedisKey);
  if (filtered.length === 0) return [];

  const CHUNK = 80;
  for (let i = 0; i < filtered.length; i += CHUNK) {
    const chunk = filtered.slice(i, i + CHUNK);
    await withRedisRetry(() => r.sadd(GLOBAL_MONITOR_KEYS_SET, ...chunk), { label: 'watch:global-migrate-sadd' });
  }
  await withRedisRetry(
    () => r.expire(GLOBAL_MONITOR_KEYS_SET, GLOBAL_MONITOR_KEYS_SET_TTL_SEC),
    { label: 'watch:global-expire' }
  ).catch(() => {});
  console.log(`[monitor] GLOBAL_MONITOR_KEYS_SET 移行: ${filtered.length} キーを登録`);
  return filtered;
}

async function mgetChunked(r, keys, chunkSize = 120) {
  const out = [];
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const vals = await withRedisRetry(() => r.mget(...chunk), { label: 'watch:mget-chunk' });
    if (Array.isArray(vals)) out.push(...vals);
  }
  return out;
}

/** フロントの normalizeMonitorId と同規則（大小・前後空白を揃える） */
function normalizeWatchId(v) {
  return String(v ?? '').trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────
//  HTTP ハンドラー
// ─────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'POST') return handleRegister(req, res);
  if (req.method === 'GET') return handleStatus(req, res);
  if (req.method === 'DELETE') return handleDelete(req, res);
  return res.status(405).json({ error: 'Method Not Allowed' });
}

/** プランのみ Redis に同期（見守り画面の選択をサーバ監視間隔に反映） */
async function handlePlanSyncOnly(req, res) {
  const { userId, plan } = req.body || {};
  if (!userId || !plan || !STOCK_CONFIG[plan]) {
    return res.status(400).json({ error: 'userId and valid plan required' });
  }
  try {
    const r = getRedis();
    await withRedisRetry(
      () => r.set(userPlanKey(userId), plan, { ex: WATCH_TTL }),
      { label: 'plan:set' }
    );
    return res.status(200).json({ ok: true, plan });
  } catch (e) {
    console.error('[monitor] plan sync Redis:', e.message);
    return res.status(503).json({
      error: 'Redis に接続できませんでした。しばらくしてから再度お試しください。',
      code:  'REDIS_UNAVAILABLE',
      detail: e.message,
    });
  }
}

/** 見守りアイテムを Redis に登録 */
async function handleRegister(req, res) {
  const body = req.body || {};
  if (body.syncPlanOnly) {
    return handlePlanSyncOnly(req, res);
  }
  const keyword = String(body.keyword || '').trim();
  const userId = String(body.userId || '').trim();
  const url = body.url != null ? String(body.url) : '';
  const title = body.title != null ? String(body.title) : '';
  const price = Number(body.price) || 0;
  const plan = body.plan;

  if (!keyword || !userId) {
    return res.status(400).json({ error: 'keyword, userId are required' });
  }

  // keyword のみ登録（URL未発見状態）をサポート。
  // sourceId は提供されなければキーワードから一意なIDを自動生成する。
  // 将来URLが発見された際に同じ sourceId で上書き登録できる。
  const kwHash = Buffer.from(keyword).toString('base64url').slice(0, 12);
  const itemId = normalizeWatchId(body.itemId) || `kwitem_${kwHash}`;
  const sourceId = normalizeWatchId(body.sourceId) || `kwsrc_${kwHash}`;

  const listPriceNum =
    body.listPrice != null && body.listPrice !== '' ? Number(body.listPrice) : NaN;
  let resolvedListPrice =
    !Number.isNaN(listPriceNum) && listPriceNum ? listPriceNum : price || 0;

  let r;
  try {
    r = getRedis();
  } catch (e) {
    console.error('[monitor] Redis init:', e.message);
    return res.status(503).json({
      error: 'Redis が未設定です。サーバー環境変数を確認してください。',
      code:  'REDIS_NOT_CONFIGURED',
      detail: e.message,
    });
  }

  // ── プラン別: 在庫見守り登録数の上限（サーバー側の厳格ガード）───────────────
  const effectivePlan = await resolveUserPlanForLimits(r, userId, plan);
  const cap = PLAN_STOCK_LIMIT[effectivePlan] || PLAN_STOCK_LIMIT.FREE;
  const indexKey = userWatchIndexKey(userId);

  const hash = itemHashKey(sourceId, itemId);
  const key = watchKey(userId, hash);

  try {
    const already = await withRedisRetry(() => r.sismember(indexKey, hash), { label: 'register:cap-sismember' }).catch(
      () => 0
    );
    if (!already) {
      const cur = await withRedisRetry(() => r.scard(indexKey), { label: 'register:cap-scard' }).catch(() => 0);
      if (Number(cur) >= cap) {
        return res.status(400).json({
          error: 'PLAN_LIMIT_REACHED',
          msg: `在庫見守り枠の上限に達しました（${effectivePlan}：最大${cap}件）。不要な見守りを削除するか、プランを変更してください。`,
          plan: effectivePlan,
          cap,
          current: Number(cur) || 0,
        });
      }
    }
  } catch (e) {
    console.error('[monitor] cap check failed:', e.message);
    // cap チェックに失敗した場合は安全側（登録を拒否）に倒す
    return res.status(503).json({
      error: 'REDIS_UNAVAILABLE',
      msg: '現在、登録制限の確認に失敗しました。しばらくしてから再度お試しください。',
      detail: e.message,
    });
  }

  // ── 品番の確定（登録時に一度だけ抽出・固定する）─────────────────────────
  // keyword と title の両方から品番を探す。
  // 登録後にショップ側のタイトルが変わっても、
  // この「登録品番」が判定の絶対的な基準になる。
  const registeredTitle = title || keyword;
  const registeredModels = [
    ...extractModelNumbers(keyword),
    ...extractModelNumbers(registeredTitle),
  ].filter((v, i, a) => a.indexOf(v) === i); // 重複除去

  // 色キーワードも登録時に確定・保存（ピンク/pink 等）
  const registeredColors = extractColorKeywords(keyword);

  if (registeredModels.length > 0) {
    console.log(`[monitor] 品番確定: ${registeredModels.join(', ')} ("${registeredTitle.slice(0,50)}")`);
  } else {
    console.log(`[monitor] 品番なし（型番未指定で登録）: "${keyword}"`);
  }
  if (registeredColors.length > 0) {
    console.log(`[monitor] 色確定: ${registeredColors.join(', ')}`);
  }

  const entry = {
    keyword,
    itemId,
    sourceId,
    userId,
    url,
    title:         registeredTitle,
    price,
    listPrice:     resolvedListPrice || 0,
    // ── 品番絶対主義の核 ────────────────────────────────────────────────
    // ハイフン以下を含む完全品番（例: ["CW2288-111"]）。
    // 空配列 = 品番指定なし（フィルタースキップ）
    modelNumbers:  registeredModels,
    // ── 色フィルターの核 ────────────────────────────────────────────────
    // 登録時のキーワードから確定した色ワード（例: ["ピンク"]）。
    // 空配列 = 色指定なし（フィルタースキップ）
    colorKeywords: registeredColors,
    // ── カテゴリ別監視モード ─────────────────────────────────────────────
    // sneaker: PDPサイズ検証あり / standard: HTML在庫変化監視
    mode:          body.mode === 'sneaker' ? 'sneaker' : 'standard',
    category:      String(body.category || 'standard'),
    canonicalName: String(body.canonicalName || keyword),
    status:        'OFF',
    addedAt:       Date.now(),
    lastCheckedAt: Date.now(),
    notifiedAt:    0,
  };

  try {
    if (process.env.RE_EYE_MONITOR_DEBUG === '1') {
      console.log(
        '[monitor][debug] Redis SET 直前',
        JSON.stringify({ itemId, sourceId, key, hash, userId })
      );
    }
    if (plan && STOCK_CONFIG[plan]) {
      await withRedisRetry(
        () => r.set(userPlanKey(userId), plan, { ex: WATCH_TTL }),
        { label: 'register:plan' }
      );
    }
    await withRedisRetry(
      () => r.set(key, JSON.stringify(entry), { ex: WATCH_TTL }),
      { label: 'register:entry' }
    );
    await withRedisRetry(
      () => r.sadd(userWatchIndexKey(userId), hash),
      { label: 'register:index' }
    );
    await withRedisRetry(
      () => r.expire(userWatchIndexKey(userId), WATCH_TTL),
      { label: 'register:index-ttl' }
    );
    await withRedisRetry(() => r.sadd(GLOBAL_MONITOR_KEYS_SET, key), { label: 'register:global-key' });
    await withRedisRetry(() => r.expire(GLOBAL_MONITOR_KEYS_SET, GLOBAL_MONITOR_KEYS_SET_TTL_SEC), { label: 'register:global-ttl' }).catch(
      () => {}
    );
    return res.status(200).json({
      registered: true,
      hash,
      itemId,
      sourceId,
      listPrice: resolvedListPrice,
      modelNumbers: registeredModels,
      colorKeywords: registeredColors,
    });
  } catch (e) {
    console.error('[monitor] register Redis:', e.message);
    return res.status(503).json({
      error: 'Redis に接続できませんでした。しばらくしてから再度お試しください。',
      code:  'REDIS_UNAVAILABLE',
      detail: e.message,
    });
  }
}

function normalizeBrowseProfileGender(q) {
  const g = String(q || '')
    .trim()
    .toLowerCase();
  if (g === 'male' || g === 'female' || g === 'unknown') return g;
  return 'unknown';
}

/**
 * GET …?serpFilter=1&keyword=&page=&limit=&gender=male|female|unknown
 * （後方互換: profileGender も gender と同義）
 * SERP→v5 軽量ノイズ→LLMバッチ1回→スコア≥0.6→PDP（靴／服／キーワード一致カテゴリ／main+confidence≥0.85）→ページング
 */
async function handleSerpFilterBrowse(req, res) {
  const uid = sanitizeUserId(String(req.query.userId || ''));
  if (!uid) return res.status(400).json({ error: 'userId required' });
  const keyword = String(req.query.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: 'keyword required for serpFilter' });

  let page = parseInt(String(req.query.page || '0'), 10);
  if (!Number.isFinite(page) || page < 0) page = 0;
  let limit = parseInt(String(req.query.limit || '10'), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  limit = Math.min(10, limit);

  const userGender = normalizeBrowseProfileGender(req.query.gender || req.query.profileGender);
  const refresh = String(req.query.refresh || '') === '1';

  let r;
  try {
    r = getRedis();
  } catch (e) {
    return res.status(503).json({
      error: 'Redis が未設定です。',
      code: 'REDIS_NOT_CONFIGURED',
      detail: e.message,
    });
  }

  const cacheKey = browseCacheKey(uid, keyword, userGender);
  const useGemini = !!String(process.env.GEMINI_API_KEY || '').trim();

  /** @type {{ adopted: object[], serpCount: number, keyword: string, classifier: string, classifierNote?: string }|null} */
  let cached = null;
  if (!refresh) {
    try {
      const raw = await withRedisRetry(() => r.get(cacheKey), { label: 'monbrowse:get' });
      if (raw) {
        const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (p && Array.isArray(p.adopted)) cached = p;
      }
    } catch {
      cached = null;
    }
  }

  if (!cached) {
    const marketResult = await searchAllCached(keyword, {
      maxResults: 10,
      cacheTtlSec: 120,
    });
    const marketItems = marketResult.items || [];
    const seenUrls = new Set();
    const items = [];
    for (const i of marketItems) {
      if (!i?.url || seenUrls.has(i.url)) continue;
      seenUrls.add(i.url);
      items.push(i);
      if (items.length >= 10) break;
    }

    const pdpPar = Math.max(1, Math.min(4, Number(process.env.RE_EYE_MONITOR_PDP_PARALLEL) || 4));
    const { adopted } = await buildSerpFilterAdoptedList(items, keyword, userGender, {
      pdpParallel: pdpPar,
    });

    adopted.sort((a, b) => b.score - a.score);

    cached = {
      adopted,
      serpCount: items.length,
      keyword,
      classifier: useGemini ? 'gemini_batch' : 'heuristic_batch',
      classifierNote: useGemini
        ? 'v5.0: ノイズ→LLMバッチ1回→スコア≥0.6→PDP（靴／服／キーワード一致カテゴリ／main+confidence≥0.85）'
        : 'GEMINI_API_KEY 未設定: ヒューリスティック分類のみ',
    };
    try {
      await withRedisRetry(
        () =>
          r.set(cacheKey, JSON.stringify(cached), {
            ex: Number(process.env.RE_EYE_MONBROWSE_TTL_SEC) > 0
              ? Number(process.env.RE_EYE_MONBROWSE_TTL_SEC)
              : 180,
          }),
        { label: 'monbrowse:set' },
      );
    } catch (e) {
      console.warn('[monitor] browse cache set:', e.message);
    }
  }

  const total = cached.adopted.length;
  const start = page * limit;
  const slice = cached.adopted.slice(start, start + limit);
  const hasMore = start + slice.length < total;

  return res.status(200).json({
    mode: 'serpFilter',
    items: slice.map(({ adopted: _a, ...rest }) => rest),
    page,
    limit,
    total,
    hasMore,
    keyword: cached.keyword,
    serpCount: cached.serpCount,
    classifier: cached.classifier,
    classifierNote: cached.classifierNote,
    gender: userGender,
    profileGender: userGender,
  });
}

/** ユーザーの全見守りアイテムを取得 */
async function handleStatus(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  if (String(req.query.serpFilter || '') === '1') {
    return handleSerpFilterBrowse(req, res);
  }

  try {
    const items = await getUserWatchItems(userId);
    return res.status(200).json({ items });
  } catch (e) {
    console.error('[monitor] GET status:', e.message);
    return res.status(503).json({
      items: [],
      error: 'Redis に接続できませんでした。しばらくしてから再度お試しください。',
      code:  'REDIS_UNAVAILABLE',
      detail: e.message,
    });
  }
}

/** 見守り 1 件を Redis から削除（エントリ + ユーザーインデックス） */
async function handleDelete(req, res) {
  const body = req.body || {};
  const userId = String(body.userId || '').trim();
  const itemId = normalizeWatchId(body.itemId);
  const sourceId = normalizeWatchId(body.sourceId);
  if (!userId || !itemId || !sourceId) {
    return res.status(400).json({ error: 'userId, itemId, sourceId are required' });
  }
  let r;
  try {
    r = getRedis();
  } catch (e) {
    console.error('[monitor] Redis init (DELETE):', e.message);
    return res.status(503).json({
      error: 'Redis が未設定です。',
      code: 'REDIS_NOT_CONFIGURED',
      detail: e.message,
    });
  }
  const hash = itemHashKey(sourceId, itemId);
  const key = watchKey(userId, hash);
  try {
    await withRedisRetry(() => r.del(key), { label: 'delete:entry' });
    await withRedisRetry(() => r.srem(userWatchIndexKey(userId), hash), { label: 'delete:index' });
    await withRedisRetry(() => r.srem(GLOBAL_MONITOR_KEYS_SET, key), { label: 'delete:global-key' }).catch(() => {});
    return res.status(200).json({ ok: true, deleted: true, hash });
  } catch (e) {
    console.error('[monitor] DELETE:', e.message);
    return res.status(503).json({
      error: 'Redis に接続できませんでした。',
      code: 'REDIS_UNAVAILABLE',
      detail: e.message,
    });
  }
}

// ─────────────────────────────────────────────────────────
//  スケジューラーから呼ばれるバッチ関数
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
//  プラン・AI ヘルパー
// ─────────────────────────────────────────────────────────

/**
 * Redis からユーザーのプランを取得する。
 * キー: userPlanKey(userId)（= user:plan:{userId}） 値: 'FREE'|'STANDARD'|'PRO'|'VIP'
 * 未設定の場合は CURRENT_PLAN を返す。
 */
async function getUserPlanBatch(r, userIds) {
  if (userIds.length === 0) return {};
  const planKeys = userIds.map(uid => userPlanKey(uid));
  const planVals = await r.mget(...planKeys);
  const map = {};
  userIds.forEach((uid, i) => {
    const p = planVals[i];
    map[uid] = (p && STOCK_CONFIG[p]) ? p : CURRENT_PLAN;
  });
  return map;
}

/**
 * 全ユーザーの見守りアイテムをチェックし、在庫変化があれば通知する
 * CLI（run-cli.mjs）または外部スケジューラから呼び出す。人工待機（sleep/jitter）は入れない。
 */
export async function checkAllWatched() {
  cliLog('[run-cli] Upstash（Redis）に接続して監視エントリを読み込みます');

  // cron 実行回数チェック（24/day）— 超過なら全体スキップ
  if (!quotaCheck('cron')) {
    const qs = quotaStatus();
    console.warn(`[monitor] cron quota exceeded — skip (${qs.cron?.count}/${qs.cron?.limit})`);
    return;
  }
  quotaConsume('cron');

  // Redis 書き込み予算チェック（8000コマンド/day）
  if (!guardRedisWrite('checkAllWatched-cycle', 40)) {
    const s = redisGuardStatus();
    console.warn(`[monitor] Redis 予算超過によりサイクルをスキップ (${s.count}/${s.limit})`);
    return;
  }

  const { intervalSec } = getStockInterval();
  if (intervalSec === null) {
    console.log('[monitor][VIP] 夜間スリープ期間 — スキップ');
    cliLog('[run-cli] 夜間スリープのため在庫監視はスキップされました');
    return;
  }

  /** JST 21:00–09:00 は実運用上の負荷平準化・通知抑制（plan-config の昼/夜とは別レイヤ）。無効化: MONITOR_JST_QUIET_DISABLED=1 */
  if (process.env.MONITOR_JST_QUIET_DISABLED !== '1') {
    try {
      const hourTok = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Tokyo',
        hour: 'numeric',
        hour12: false,
      }).formatToParts(new Date())
        .find((p) => p.type === 'hour')?.value;
      const hj = Number(hourTok ?? 'NaN');
      if (Number.isFinite(hj) && (hj >= 21 || hj < 9)) {
        console.log('[monitor] JST 静粭時間（21–09）— checkAllWatched スキップ');
        cliLog('[run-cli] JST 静粭時間のため処理しません');
        return;
      }
    } catch {
      // noop
    }
  }

  const r = getRedis();
  let keys = [];
  try {
    keys = await fetchAllMonitorEntryKeys(r);
  } catch (e) {
    console.error('[monitor] 監視キー列挙エラー:', e.message);
    cliLog('[run-cli] 監視キーの列挙に失敗しました:', e.message);
    return;
  }

  cliLog(`[run-cli] Upstash から読み込んだ監視キー数: ${keys.length} 件`);

  if (keys.length === 0) {
    cliLog('[run-cli] 監視対象が空っぽです');
    return;
  }

  const values = await mgetChunked(r, keys);
  const { entries: allEntries, issues: loadIssues } = parseMonitorEntriesFromMget(
    keys,
    values,
    MONITOR_SCHEMA_VERSION
  );

  for (const iss of loadIssues) {
    const head = `[monitor] 監視エントリ読み込み [${iss.type}] ${iss.key}`;
    if (iss.preview) {
      console.warn(head, '—', iss.message, '\n  preview:', iss.preview);
    } else {
      console.warn(head, '—', iss.message);
    }
    if (isRunCli()) {
      cliLog(`[run-cli] ${head} — ${iss.message}${iss.preview ? ` …${iss.preview.slice(0, 100)}` : ''}`);
    }
  }

  cliLog(`[run-cli] 有効な監視エントリ（オブジェクトとして復元できた件数）: ${allEntries.length} 件`);

  if (keys.length > 0 && allEntries.length === 0) {
    cliLog('[run-cli] 監視キーはありますが有効データが 0 件です。直前の [monitor] 警告に原因が出ています。');
    return;
  }

  // ── プラン別インターバルフィルター ──────────────────────────────────────
  // ユーザーごとのプランを一括取得し、「まだ監視する時間ではない」アイテムをスキップ。
  // VIP/PRO = 300秒ごと（5分Cron毎に全チェック）
  // STANDARD = 900秒ごと（3回に1回チェック）
  // FREE     = 3600秒ごと（12回に1回チェック）
  const userIds = [...new Set(allEntries.map(e => e.userId).filter(Boolean))];
  const planMap = await getUserPlanBatch(r, userIds);

  const now = Date.now();
  const entries = allEntries.filter(entry => {
    const plan = planMap[entry.userId] || CURRENT_PLAN;
    const { intervalSec, jitterSec } = getStockIntervalForPlan(plan);
    if (intervalSec === null) return false; // 夜間スキップ対象プラン
    const elapsedSec = (now - (entry.lastCheckedAt || 0)) / 1000;
    const delta =
      jitterSec && Number.isFinite(jitterSec)
        ? Math.floor(Math.random() * jitterSec * 2) - jitterSec
        : 0;
    // Adaptive Monitoring: mode・熱量に応じて間隔を動的調整
    const adaptiveMul = getAdaptiveIntervalMultiplier(entry);
    const target = Math.max(0, (intervalSec + delta) * adaptiveMul);
    return elapsedSec >= target;
  });

  if (entries.length < allEntries.length) {
    console.log(`[monitor] プラン別フィルター: ${entries.length}/${allEntries.length}件を対象（残りはインターバル未達）`);
  }

  cliLog(`[run-cli] 今回チェックする監視対象: ${entries.length} 件（プラン・インターバル適用後）`);

  if (entries.length === 0) {
    cliLog('[run-cli] 全件がインターバル待ちのため、今回は API を呼びません');
    return;
  }

  // アイテムごとに現在の在庫を確認（並列数 5 — API Rate Limit 対策。バッチ間の人工待機は入れない）
  const CONCURRENCY = 5;
  const totalBatches = Math.ceil(entries.length / CONCURRENCY);
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const batchNo = Math.floor(i / CONCURRENCY) + 1;
    cliLog(`[run-cli] バッチ ${batchNo}/${totalBatches}（${batch.length} 件）を処理中…`);
    const settled = await Promise.allSettled(batch.map(entry => checkAndNotify(r, entry)));
    settled.forEach((res, j) => {
      const entry = batch[j];
      const name = (entry.title || entry.keyword || entry.itemId || '?').slice(0, 56);
      if (res.status === 'rejected') {
        cliLog(`[run-cli] 監視: 「${name}」→ エラー: ${res.reason?.message || res.reason}`);
        return;
      }
      const v = res.value;
      if (v && typeof v === 'object' && v.outcome) {
        const extra = v.detail ? ` (${v.detail})` : '';
        cliLog(`[run-cli] 監視: 「${v.label || name}」→ ${v.outcome}${extra}`);
      }
    });
  }
}

// ─────────────────────────────────────────────────────────
//  全方位波及検索エンジン
// ─────────────────────────────────────────────────────────

/**
 * 全方位波及検索: 公式の在庫状況に関わらず常に実行する。
 * 楽天・Yahoo API のみ（Google / SerpAPI はコスト削減のため未使用）。
 *
 * @param {string} keyword       ユーザー登録キーワード
 * @param {string} officialTitle 公式タイトル（品番抽出に使用）
 * @returns {{ cascadeText: string, marketFound: boolean, cheapest: object|null, googleFound: boolean }}
 */
async function runCascadeSearch(keyword, officialTitle, _userId) {
  try {
    const sizeInfo = extractSizeFromKeyword(keyword);

    console.log(
      `[CASCADE] 開始: keyword="${String(keyword ?? '').slice(0, 60)}" ` +
      `size=${sizeInfo ? `${sizeInfo.raw}(${sizeInfo.type})` : 'なし'}`
    );

    const marketResult = await searchAllCached(keyword, {
      maxResults: 10,
      cacheTtlSec: 120,
    });
    const marketItems = marketResult.items || [];

    const priced = marketItems.filter((i) => (i.price || 0) > 0);
    const cheapest = priced.length > 0
      ? priced.reduce((a, b) => ((a.price || 0) <= (b.price || 0) ? a : b))
      : null;
    const marketFound = cheapest !== null;

    const parts = [];
    if (cheapest) parts.push(`楽天・Yahoo最安 ¥${cheapest.price.toLocaleString()}`);
    const cascadeText = parts.length > 0 ? ` / ${parts.join(' / ')}` : '';

    console.log(`[CASCADE] 結果: 楽天・Yahoo価格付きヒット ${priced.length}件 marketFound=${marketFound}`);

    return { cascadeText, marketFound, cheapest, googleFound: false };
  } catch(e) {
    console.warn('[CASCADE] 波及検索失敗:', e.message);
    return { cascadeText: '', marketFound: false, cheapest: null, googleFound: false };
  }
}

// ─────────────────────────────────────────────────────────
//  SERP 監視（楽天・Yahoo のみ・ルールベース）
// ─────────────────────────────────────────────────────────

/**
 * PDP verify など重い処理の同時実行数（fail-close と相性のため上限付き）。
 * `RE_EYE_MONITOR_PDP_PARALLEL` で 1–6 を上書き可。
 *
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<unknown>} mapper
 * @template T
 */
async function pmapMonitorWithConcurrency(items, concurrency, mapper) {
  const n = Math.max(0, items.length);
  if (n === 0) return [];
  const slots = Math.max(1, Math.min(concurrency, n));
  const out = new Array(n);
  let wi = 0;
  async function worker() {
    while (true) {
      const i = wi++;
      if (i >= n) return;
      out[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: slots }, () => worker()));
  return out;
}

/**
 * serpUrls: Redis に保存する「前回検索時の URL セット」（SERP ヒット最大10件と同型）
 * serpPdpDomStructural: URLキー→PDP dom_structural かつ CE 非 reject（最終 ON。OFF→ON 判定用）
 */
async function checkAndNotifySerp(r, entry) {
  const { keyword, userId, itemId, sourceId, title, listPrice } = entry;
  const label = (title || keyword || itemId || '?').slice(0, 56);

  const kwSizeForPdp = extractSizeFromKeyword(keyword);

  let settings = null;
  if (userId) {
    settings = await loadUserSettings(userId);
  }
  const userGender = userGenderForSerpV5(settings);

  const notifyPlan = await resolveNotifyPlan(r, userId);
  const useDigest = digestPathForPlan(notifyPlan) === 'digest';

  console.log(
    `[SERP] "${String(keyword).slice(0, 40)}" ` +
      `keywordRaw size=${kwSizeForPdp ? `${kwSizeForPdp.raw}(${kwSizeForPdp.type})` : 'なし'} v5_gender=${userGender}`
  );

  const marketResult = await searchAllCached(keyword, {
    maxResults: 10,
    cacheTtlSec: 120,
  });
  const searchErrs = marketResult.errors || [];
  if (isRunCli() && searchErrs.length) {
    for (const err of searchErrs) {
      cliLog(`[run-cli] ショップ検索 API: ${err}`);
    }
  }
  const marketItems = marketResult.items || [];

  const seenUrls = new Set();
  const allItems = [];
  for (const i of marketItems || []) {
    if (!i?.url || seenUrls.has(i.url)) continue;
    seenUrls.add(i.url);
    allItems.push(i);
    if (allItems.length >= 10) break;
  }

  // 有効 URL のみ抽出
  const currentUrls = allItems.map(i => i.url);

  // ── Step 3: 差分検知 ────────────────────────────────────────────────────────
  const prevUrls = entry.serpUrls; // undefined = 初回

  if (prevUrls === undefined) {
    // 初回: ベースライン確立（通知なし）
    console.log(`[SERP] ベースライン確立: ${currentUrls.length}件（楽天・Yahoo）`);
    const hash = itemHashKey(sourceId, itemId);
    await r.set(watchKey(userId, hash), JSON.stringify({
      ...entry,
      serpUrls:      currentUrls,
      lastCheckedAt: Date.now(),
      schemaVersion: MONITOR_SCHEMA_VERSION,
    }), { ex: WATCH_TTL });
    const errHint = searchErrs.length ? ` ※APIエラーあり: ${searchErrs.length}件` : '';
    return {
      label,
      outcome: searchErrs.length && currentUrls.length === 0 ? 'エラー（検索結果0件）' : 'ベースライン確立',
      detail:  `${currentUrls.length}件ヒット${errHint}`.trim(),
    };
  }

  const newItems = allItems.filter(i => i.url && !prevUrls.includes(i.url));

  console.log(
    `[SERP] 現在${currentUrls.length}件 前回${prevUrls.length}件 新着${newItems.length}件`,
  );

  if (newItems.length === 0) {
    // 変化なし → タイムスタンプ更新のみ
    const hash = itemHashKey(sourceId, itemId);
    await r.set(watchKey(userId, hash), JSON.stringify({
      ...entry,
      serpUrls:      currentUrls,
      lastCheckedAt: Date.now(),
      schemaVersion: MONITOR_SCHEMA_VERSION,
    }), { ex: WATCH_TTL });
    return {
      label,
      outcome: searchErrs.length ? '新着なし（検索APIにエラーあり）' : '新着なし',
      detail:  searchErrs.length ? searchErrs.join('; ') : undefined,
    };
  }

  /** prevUrls に無い URL のみ PDP。ソース配列先頭から最大10件だけ走査（配列 slice は使わない） */
  const itemsToEvaluate = newItems;
  /** 直近サイクルで PDP した URL の dom_structural 真偽（entry にマージ） */
  const pdpDomStructuralDelta = {};

/** v5 FINAL: 新着先頭最大10件 → LLM+score → runSerpV5PdpVerify のみ */
const staged = [];
for (let ii = 0; ii < itemsToEvaluate.length && ii < 10; ii++) {
  const item = itemsToEvaluate[ii];

  // --- ここから指示通り追加 ---
  const noise = analyzeNoise(item);

  // 即死判定
  if (noise.isNoise) {
    console.log(`[NoiseGuard:REJECT] ${item.title?.slice(0, 40)}`);
    continue;
  }
  // --- ここまで ---

  // 以前の if (isNoise(item)) ロジックは analyzeNoise に統合されたので
  // ここから下の価格チェックに繋げます
  const itemPrice = item.price || 0;
  if (listPrice > 0 && itemPrice > 0) {
    const ratio = itemPrice / listPrice;
    if (ratio < 0.5 || ratio > 2.5) {
      console.log(`[SERP] 価格異常: ¥${itemPrice} / 参考¥${listPrice}`);
      continue;
    }
  }

  staged.push(item);
} // 【重要】ここで for ループが閉じます。これより下はループの外です。

const scored = await classifyAndScoreSerpItemsV5(staged, userGender);

const pdpParallel = Math.max(
  1,
  Math.min(6, Number(process.env.RE_EYE_MONITOR_PDP_PARALLEL) || 4),
);

  /** @type {Array<{ item: object, itemPrice: number, row: object, score: number, task: object|null }>} */
  const rowsWithTask = [];
  for (let i = 0; i < scored.length; i++) {
    const rec = scored[i];
    const item = rec.item;
    const itemPrice = Number(item.price) || 0;
    const task = resolveSerpV5PdpTask(rec.row, item, entry, kwSizeForPdp);
    if (task) {
      console.log(
        `[SERP] v5 PDP arm=${task.kind}: "${(item.title || '').slice(0, 50)}" ¥${itemPrice.toLocaleString()} ${(item.url || '').slice(0, 50)}`,
      );
    }
    rowsWithTask.push({ item, itemPrice, row: rec.row, score: rec.score, task });
  }

  const needPdp = rowsWithTask.filter((r) => r.task);
  if (scored.length > 0 && needPdp.length === 0) {
    console.log('[SERP] v5: スコア通過ありだが PDP 発火条件なし（靴／服サイズ・カテゴリ+キーワード・main+confidence）');
  }

  /** @type {{ item: object, itemPrice: number }[]} */
  const rowsNotify = [];

  if (needPdp.length > 0) {
    const withPdp = await pmapMonitorWithConcurrency(needPdp, pdpParallel, async (row) => {
      const pdpv = await runSerpV5PdpVerify(row.item, row.task);
      return { ...row, pdpv };
    });

    for (const row of withPdp) {
      const { pdpv, item, itemPrice, task } = row;
      const clsRow = row.row;
      const urlKey = monitorSerpDomUrlKey(item.url);
      const strictPdpOk = isSerpV5PdpDomStructuralOn(pdpv);
      const serpStrong = serpV5AnchorProgramMatch(entry, item);
      const ce = evaluateContradictionEngine({
        llmCategory: String(clsRow?.category || 'other'),
        llmConfidence: Number(clsRow?.confidence) || 0,
        serpStrongMatch: serpStrong,
        pdpResult: strictPdpOk ? 'on' : 'off',
        pdpRetryable: !!pdpv.retryable,
        pdpReason: String(pdpv?.reason || ''),
        userGender,
        productGender: String(clsRow?.gender || 'unknown'),
        productRole: String(clsRow?.product_role || 'unknown'),
      });
      const finalStockOn = isSerpV5FinalStockOn(pdpv, ce);
      pdpDomStructuralDelta[urlKey] = finalStockOn;

      if (!strictPdpOk) {
        const retryableFetch =
          !!pdpv.retryable && String(pdpv.reason || '') === 'fetch_fail_strict';
        if (retryableFetch) {
          scheduleRetry(item, {
            source: 'monitor_serp_pdp',
            userId: String(userId).slice(0, 24),
            size: task?.kind === 'shoe' ? String(kwSizeForPdp?.raw || '') : String(task?.kind || ''),
          });
        }
        if (ce.status === 'reject' && ce.flags.length > 0) {
          opsJsonLog('monitor_serp_ce_contradiction', {
            flags: ce.flags,
            reason: ce.reason,
            url: item.url?.slice(0, 90),
            userId: String(userId).slice(0, 10),
          });
          void recordCeRejectionSafe({
            source: 'monitor_serp_pdp_off',
            flags: ce.flags,
            reason: ce.reason,
            keyword: String(keyword || title || ''),
            urlHost: ceFeedbackUrlHost(item.url),
          });
        }
        opsJsonLog(
          retryableFetch ? 'monitor_serp_skip_pdp_retryable' : 'monitor_serp_skip_pdp',
          {
            ok: pdpv.ok,
            tentative: !!pdpv.pdpTentative,
            reason: pdpv.reason,
            method: pdpv.method,
            retryable: !!pdpv.retryable,
            url: item.url?.slice(0, 90),
            userId: String(userId).slice(0, 10),
          },
        );
        continue;
      }

      const prevDomOn =
        entry.serpPdpDomStructural &&
        typeof entry.serpPdpDomStructural === 'object' &&
        entry.serpPdpDomStructural[urlKey] === true;
      if (prevDomOn) {
        opsJsonLog('monitor_serp_skip_pdp', {
          reason: 'already_dom_structural',
          url: urlKey.slice(0, 90),
          userId: String(userId).slice(0, 10),
        });
        continue;
      }

      if (ce.status === 'reject') {
        opsJsonLog('monitor_serp_ce_reject', {
          flags: ce.flags,
          reason: ce.reason,
          confidencePenalty: ce.confidencePenalty,
          url: item.url?.slice(0, 90),
          userId: String(userId).slice(0, 10),
        });
        void recordCeRejectionSafe({
          source: 'monitor_serp_pdp_on',
          flags: ce.flags,
          reason: ce.reason,
          keyword: String(keyword || title || ''),
          urlHost: ceFeedbackUrlHost(item.url),
        });
        continue;
      }

      rowsNotify.push({ item, itemPrice });
    }
  }

  const sizeInfo = kwSizeForPdp;

  for (const row of rowsNotify) {
    const { item } = row;
    const itemPrice = row.itemPrice || 0;

    if (!shoeProfileAllowsListing(settings, sizeInfo)) {
      opsJsonLog('size_gate_skip', {
        source: 'monitor_serp',
        userId: String(userId).slice(0, 10),
      });
      continue;
    }

    const minLtqRaw = Number(process.env.RE_EYE_LTV_MIN_SCORE_FREE);
    const minLtq = Number.isFinite(minLtqRaw) ? minLtqRaw : 0;
    const ltqScore = computeLtqScore({
      price: itemPrice,
      listPrice,
      title: item.title || '',
    });
    if (
      shouldSkipLtqFree({
        plan: notifyPlan,
        score: ltqScore,
        minScore: minLtq,
        skipPaidLtq: true,
      })
    ) {
      opsJsonLog('notification_skip_ltq', {
        source: 'monitor_serp',
        score: ltqScore,
        min: minLtq,
      });
      continue;
    }

    const boostMinRaw = Number(process.env.RE_EYE_CTR_BOOST_MIN_SCORE_FREE ?? '0');
    const boostMin = Number.isFinite(boostMinRaw) ? boostMinRaw : 0;
    const boostScore = computeCtrBoostScore({
      shoeRaw: sizeInfo?.type === 'shoe' ? sizeInfo.raw : undefined,
      title: item.title || '',
      keyword: title || keyword || '',
    });
    if (boostMin > 0 && !isPaidPlan(notifyPlan) && boostScore < boostMin) {
      opsJsonLog('ctr_boost_skip', {
        source: 'monitor_serp',
        score: boostScore,
        min: boostMin,
      });
      continue;
    }

    const dpre = await freeDailyCapPreSend(r, userId, notifyPlan);
    if (!dpre.ok) {
      opsJsonLog('notification_skip_daily_cap_free', {
        cap: dpre.cap,
        cur: dpre.cur,
      });
      continue;
    }

    const burstOk = await allowMonitorUserPushBurst(r, userId);
    if (!burstOk) {
      opsJsonLog('rate_limit_skip', { source: 'monitor_serp' });
      continue;
    }

    const freePeakDefer =
      process.env.RE_EYE_FREE_PEAK_DEFER === '1' ||
      process.env.RE_EYE_FREE_PEAK_DEFER === 'true';
    if (
      freePeakDefer &&
      notifyPlan === 'FREE' &&
      !useDigest &&
      getTimeScoreJst() < 1.0
    ) {
      opsJsonLog('notify_defer_offpeak', {
        source: 'monitor_serp',
        userId: String(userId).slice(0, 10),
        jstHour: getJstHour(),
        timeScore: getTimeScoreJst(),
      });
      continue;
    }

    const gapOkFree = await allowFreePushMinGap(r, userId, notifyPlan);
    if (!gapOkFree) {
      opsJsonLog('notify_skip_min_gap', { source: 'monitor_serp' });
      continue;
    }

    const dedupeKey = notifySentDedupeKey(userId, item.sourceId || '', item.itemId || '');
    try {
      const nx = await withRedisRetry(
        () => r.set(dedupeKey, '1', { ex: 14400, nx: true }), // 4時間（600s→14400s）: 同一商品の通知スパム防止
        { label: 'serp-notify-dedupe-nx' }
      );
      if (nx == null) {
        continue;
      }

      // ── Negative Signal フィルタ ──────────────────────────────────────────
      // 「予約終了」「販売終了」「完売」等のテキストが含まれる場合は通知しない。
      // 「予約」だけ拾って「予約終了」を誤通知するパターンを防ぐ。
      const negCheck = checkNegativeSignal(item.title || '');
      if (negCheck.negative) {
        console.log(`[monitor] negative signal skip: "${(item.title || '').slice(0, 40)}" reason=${negCheck.reason}`);
        await withRedisRetry(() => r.del(dedupeKey), { label: 'serp-notify-neg-signal-rollback' }).catch(() => {});
        continue;
      }

      const sizeKeys = shoeSizeTagKeysFromKeywordSizeInfo(sizeInfo);
      const variant = ctrVariant(userId);
      const ctrPack = buildStockMonitorCtr({
        itemTitle: item.title,
        keywordLabel: title || keyword,
        shoeRaw: sizeInfo?.type === 'shoe' ? sizeInfo.raw : undefined,
        clothingAlpha: sizeInfo?.type === 'clothing' ? sizeInfo.raw : undefined,
        price: itemPrice,
        listPrice,
        variant,
        stockHint: 'ok',
      });
      const heatSig = computeHeatSignals(entry);

      if (useDigest) {
        await enqueueDigestItem(r, {
          target: userId,
          item: {
            type: 'serp_new',
            displayTitle: ctrPack.title,
            displayMessage: ctrPack.message,
            title: `[新着在庫] ${title || keyword}`,
            url: item.url,
            itemUrl: item.url,
            keyword,
            shop: item.sourceId || '',
            ctrTemplate: ctrPack.templateId,
            heatLabel: heatSig.label,
            opsPlan: notifyPlan,
            ...(sizeKeys ? { sizeTagKeys: sizeKeys } : {}),
          },
          onFlush: async (p) => sendMonitorDigest(r, p),
        });
      } else {
        await sendOneSignalNotification({
          title: ctrPack.title,
          message: ctrPack.message,
          url: item.url,
          data: {
            type: 'serp_new',
            userId,
            opsPlan: notifyPlan,
            opsSource: 'monitor_serp',
            ctrVariant: variant,
            ctrTemplate: ctrPack.templateId,
            ...(heatSig.label === 'high' ? { ctrHeat: heatSig.label } : {}),
            itemUrl: item.url,
            keyword,
            shop: item.sourceId || '',
            pdpStructural: true,
            monitoredAt: Date.now(),
            monitoredSizeKey:
              sizeInfo?.type === 'shoe'
                ? `${sizeInfo.raw}cm`
                : sizeInfo?.type === 'clothing'
                  ? `SIZE_${String(sizeInfo.raw || '').toUpperCase()}`
                  : undefined,
            ...(sizeKeys ? { sizeTagKeys: sizeKeys } : {}),
          },
        });
      }
    } catch(e) {
      try {
        await withRedisRetry(() => r.del(dedupeKey), { label: 'serp-notify-dedupe-rollback' });
      } catch {/* ok */}
      opsJsonLog('notification_send_fail', { source: 'monitor_serp', message: e.message });
      console.error('[SERP] OneSignal 通知失敗:', e.message);
    }
  }

  // ── Step 6: 状態を更新（GET /api/monitor・フロントが参照する status / url / price / results）────
  const hash = itemHashKey(sourceId, itemId);
  const resultsPayload =
    rowsNotify.length > 0
      ? rowsNotify.map(({ item: it }) => ({
          title: it.title || '',
          url: it.url || '',
          price: Number(it.price) || 0,
          sourceId: it.sourceId || '',
          itemId: String(it.itemId || ''),
          shopName: it.shopName || '',
          matchedAt: Date.now(),
          pdpDomStructural: true,
        }))
      : undefined;
  const primary = rowsNotify[0]?.item;

  const mergedSerpDom =
    Object.keys(pdpDomStructuralDelta).length > 0
      ? (() => {
          const prev = entry.serpPdpDomStructural;
          const base =
            prev && typeof prev === 'object' && !Array.isArray(prev)
              ? { ...prev }
              : {};
          Object.assign(base, pdpDomStructuralDelta);
          return base;
        })()
      : entry.serpPdpDomStructural;

  await r.set(
    watchKey(userId, hash),
    JSON.stringify({
      ...entry,
      serpUrls:      currentUrls,
      ...(mergedSerpDom ? { serpPdpDomStructural: mergedSerpDom } : {}),
      lastCheckedAt: Date.now(),
      schemaVersion: MONITOR_SCHEMA_VERSION,
      ...(rowsNotify.length > 0
        ? {
            notifiedAt: Date.now(),
            status:     'ON',
            results:    resultsPayload,
            url:        primary?.url || entry.url,
            price:      Number(primary?.price) || entry.price || 0,
          }
        : {}),
    }),
    { ex: WATCH_TTL }
  );

  let outcome;
  if (searchErrs.length) {
    outcome =
      rowsNotify.length > 0
        ? `PDP確認・通知あり（${rowsNotify.length}件）※検索APIエラーあり`
        : 'PDP未達・通知なし ※検索APIエラーあり';
  } else if (rowsNotify.length > 0) {
    outcome = `PDP確認・通知あり（${rowsNotify.length}件）`;
  } else {
    outcome = 'PDP未達（ノイズ・不一致・サイズ未定・またはPDP NG）';
  }
  return {
    label,
    outcome,
    detail: searchErrs.length ? searchErrs.join('; ') : undefined,
  };
}

// ─────────────────────────────────────────────────────────
//  公式 URL: PDP（dom_structural）のみが真実。cascade は市場参照メタのみ（通知は PDP 復活のみ）。
// ─────────────────────────────────────────────────────────

/**
 * @param {import('@upstash/redis').Redis} r
 */
async function checkOfficialAndNotify(r, entry, lastStatus) {
  const { url, keyword, title, price, listPrice, userId, itemId, sourceId } = entry;
  const label = (title || keyword || '?').slice(0, 56);

  console.log(`[monitor][公式] PDP truth:「${title?.slice(0, 40)}」 ${String(url || '').slice(0, 60)}`);

  const cascade = await runCascadeSearch(keyword, title, userId);
  const prevMarketStatus = entry.marketStatus || 'NOT_FOUND';
  const newMarketStatus = cascade.marketFound ? 'FOUND' : 'NOT_FOUND';

  const kwSizeForPdp = extractSizeFromKeyword(keyword || '');
  const officialPdpTask = buildSerpV5OfficialUrlPdpTask(kwSizeForPdp);

  let pdpv = { ok: false, reason: 'no_input', method: 'none', pdpTentative: false, retryable: false };
  let structuralOk = false;

  if (officialPdpTask && url) {
    pdpv = await runSerpV5PdpVerify({ url }, officialPdpTask);
    structuralOk = isSerpV5PdpDomStructuralOn(pdpv);

    if (!structuralOk && !!pdpv.retryable && String(pdpv.reason || '') === 'fetch_fail_strict') {
      scheduleRetry(
        { url },
        {
          source: 'monitor_official_pdp',
          userId: String(userId).slice(0, 24),
          size: String(kwSizeForPdp.raw || ''),
        },
      );
    }
  }

  const newStatus = structuralOk ? 'ON' : 'OFF';
  const transitionedToStructural = structuralOk && lastStatus !== 'ON';

  const notifySettings = userId ? await loadUserSettings(userId) : null;
  const offPlan = userId ? await resolveNotifyPlan(r, userId) : 'FREE';

  const sizeGateOk = shoeProfileAllowsListing(notifySettings, kwSizeForPdp);

  const minLtqRaw = Number(process.env.RE_EYE_LTV_MIN_SCORE_FREE);
  const minLtq = Number.isFinite(minLtqRaw) ? minLtqRaw : 0;
  const ltqScoreOff = computeLtqScore({
    price: Number(price) || 0,
    listPrice: Number(listPrice) || 0,
    title: title || '',
  });
  const skipLtqOfficial =
    shouldSkipLtqFree({
      plan: offPlan,
      score: ltqScoreOff,
      minScore: minLtq,
      skipPaidLtq: true,
    });

  const dcOfficial = await freeDailyCapPreSend(r, userId, offPlan);

  let burstOk = false;
  if (userId && sizeGateOk && !skipLtqOfficial && dcOfficial.ok) {
    burstOk = await allowMonitorUserPushBurst(r, userId);
  }
  const sizeKeysOfficial = shoeSizeTagKeysFromKeywordSizeInfo(kwSizeForPdp);

  const offDigest = digestPathForPlan(offPlan) === 'digest';
  const officialPeakDefer =
    process.env.RE_EYE_FREE_PEAK_DEFER === '1' ||
    process.env.RE_EYE_FREE_PEAK_DEFER === 'true';

  let officialNotifySent = false;

  const ctrOff = buildStockMonitorCtr({
    itemTitle: title,
    keywordLabel: title || keyword,
    shoeRaw: kwSizeForPdp?.type === 'shoe' ? kwSizeForPdp.raw : undefined,
    clothingAlpha: kwSizeForPdp?.type === 'clothing' ? kwSizeForPdp.raw : undefined,
    price: Number(price) || 0,
    listPrice: Number(listPrice) || 0,
    variant: ctrVariant(userId),
    stockHint: 'ok',
  });

  if (
    transitionedToStructural &&
    userId &&
    officialPdpTask &&
    sizeGateOk &&
    !skipLtqOfficial &&
    dcOfficial.ok &&
    burstOk &&
    !(officialPeakDefer && offPlan === 'FREE' && !offDigest && getTimeScoreJst() < 1.0)
  ) {
    if (!(await allowFreePushMinGap(r, userId, offPlan))) {
      opsJsonLog('notify_skip_min_gap', { source: 'monitor_official' });
    } else {
      try {
        await sendOneSignalNotification({
          title: ctrOff.title,
          message: ctrOff.message,
          url,
          data: {
            type: 'official_pdp_restock',
            itemId,
            sourceId,
            userId,
            itemUrl: url,
            keyword,
            ctrTemplate: ctrOff.templateId,
            opsPlan: offPlan,
            opsSource: 'monitor_official',
            marketStatusMeta: newMarketStatus,
            pdpStructural: true,
            monitoredAt: Date.now(),
            ...(sizeKeysOfficial ? { sizeTagKeys: sizeKeysOfficial } : {}),
          },
        });
        officialNotifySent = true;
      } catch (e) {
        opsJsonLog('notification_send_fail', { source: 'monitor_official', message: e.message });
      }
    }
  } else {
    if (!officialPdpTask) {
      opsJsonLog('monitor_serp_skip_pdp', {
        ok: !!pdpv.ok,
        reason: 'official_no_keyword_size',
        source: 'monitor_official',
        userId: String(userId).slice(0, 10),
      });
    } else if (!structuralOk) {
      opsJsonLog('monitor_serp_skip_pdp', {
        ok: !!pdpv.ok,
        reason: String(pdpv.reason || ''),
        retryable: !!pdpv.retryable,
        source: 'monitor_official',
        userId: String(userId).slice(0, 10),
      });
    }
    if (transitionedToStructural === false || !sizeGateOk) {
      /* 通知しない */
      if (!sizeGateOk) {
        opsJsonLog('size_gate_skip', {
          source: 'monitor_official',
          userId: String(userId).slice(0, 10),
        });
      } else if (skipLtqOfficial) {
        opsJsonLog('notification_skip_ltq', {
          source: 'monitor_official',
          score: ltqScoreOff,
          min: minLtq,
        });
      } else if (!dcOfficial.ok) {
        opsJsonLog('notification_skip_daily_cap_free', {
          cap: dcOfficial.cap,
          cur: dcOfficial.cur,
        });
      } else if (!burstOk && userId) {
        opsJsonLog('rate_limit_skip', { source: 'monitor_official' });
      }
    }
  }

  const hash = itemHashKey(sourceId, itemId);
  const baseOut = {
    ...entry,
    status: newStatus,
    marketStatus: newMarketStatus,
    lastCheckedAt: Date.now(),
    schemaVersion: MONITOR_SCHEMA_VERSION,
    ...(officialNotifySent ? { notifiedAt: Date.now() } : {}),
  };
  await r.set(watchKey(userId, hash), JSON.stringify(baseOut), { ex: WATCH_TTL });

  return {
    label,
    outcome:
      transitionedToStructural
        ? 'PDP復活検知・通知済'
        : `PDP状態維持（${newStatus}）／市場=${newMarketStatus}`,
    detail: cascade.cascadeText || undefined,
  };
}

/**
 * 単一アイテムの在庫チェックと通知
 */
async function checkAndNotify(r, entry) {
  const { keyword, itemId, sourceId, userId, url, title, price, listPrice } = entry;

  // ── スキーマバージョン強制リセット ──────────────────────────────────────
  const schemaOk = entry.schemaVersion === MONITOR_SCHEMA_VERSION;
  const lastStatus = schemaOk ? entry.status : 'OFF';
  if (!schemaOk) {
    console.log(
      `[monitor] スキーマバージョン不一致 → lastStatus を 'OFF' にリセット: 期待="${MONITOR_SCHEMA_VERSION}" 実際="${entry.schemaVersion ?? '(フィールドなし)'}" entry="${title?.slice(0, 40)}"`
    );
  }

  // ── 公式URL特権パス ────────────────────────────────────────────────────────
  // 公式サイトが「在庫あり」と言えば他の全フィルターを無視して即通知。
  if (isOfficialUrl(url)) {
    console.log(`[monitor][公式特権] ルーティング: "${title?.slice(0, 40)}"`);
    return checkOfficialAndNotify(r, entry, lastStatus);
  }

  // ── V11: リサーチ起点型 SERP 監視 ───────────────────────────────────────────
  // 「特定URLの生死確認」から「検索結果に新着ショップが現れた瞬間の検知」へ大転換。
  // 品番+色+サイズ+性別 の4軸クエリで SERP を定点観測し、差分を AI が目視代行。
  return checkAndNotifySerp(r, entry);
}

// ─────────────────────────────────────────────────────────
//  内部ヘルパー
// ─────────────────────────────────────────────────────────

async function getUserWatchItems(userId) {
  const r = getRedis();
  const indexKey = userWatchIndexKey(userId);
  let keys = [];
  const hashes = await withRedisRetry(() => r.smembers(indexKey), { label: 'watch:smembers' }).catch(() => []);
  if (Array.isArray(hashes) && hashes.length > 0) {
    keys = hashes.map((h) => watchKey(userId, h));
  } else {
    keys = await withRedisRetry(() => r.keys(monitorUserEntryKeysPattern(userId)), { label: 'watch:keys' });
  }
  if (keys.length === 0) return [];
  const values = await withRedisRetry(() => r.mget(...keys), { label: 'watch:mget' });
  return values
    .filter(Boolean)
    .map(v => {
      try {
        const o = JSON.parse(v);
        if (!o || typeof o !== 'object') return null;
        return {
          ...o,
          itemId: normalizeWatchId(o.itemId),
          sourceId: normalizeWatchId(o.sourceId),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────
//  オークション相場チェック（1日1回スケジューラーから呼び出し）
// ─────────────────────────────────────────────────────────

/**
 * 全見守りアイテムについてヤフオク相場を確認し、
 * 定価を上回っていれば該当ユーザーに通知する
 */
export async function checkAuctionPrices() {
  const r = getRedis();
  let keys = [];
  try {
    keys = await fetchAllMonitorEntryKeys(r);
  } catch (e) {
    console.error('[auction] 監視キー列挙エラー:', e.message);
    return;
  }
  if (keys.length === 0) return;

  const values = await mgetChunked(r, keys);
  const { entries: parsedEntries, issues: auctionLoadIssues } = parseMonitorEntriesFromMget(
    keys,
    values,
    MONITOR_SCHEMA_VERSION
  );
  for (const iss of auctionLoadIssues) {
    const head = `[auction] 監視エントリ読み込み [${iss.type}] ${iss.key}`;
    if (iss.preview) {
      console.warn(head, '—', iss.message, '\n  preview:', iss.preview);
    } else {
      console.warn(head, '—', iss.message);
    }
  }

  // 定価が登録されているアイテムのみ対象
  const targets = parsedEntries.filter(e => e.price && e.price > 0);
  console.log(`[auction] 対象アイテム ${targets.length} 件`);

  const AUCTION_CONCURRENCY = 3;
  for (let i = 0; i < targets.length; i += AUCTION_CONCURRENCY) {
    const batch = targets.slice(i, i + AUCTION_CONCURRENCY);
    await Promise.allSettled(batch.map((entry) => checkAuctionAndNotify(r, entry)));
  }
}

async function checkAuctionAndNotify(r, entry) {
  const { keyword, title, price: listPrice, userId, itemId, sourceId } = entry;

  let auctionMin;
  try {
    auctionMin = await getAuctionMinPrice(keyword);
  } catch(e) {
    console.error(`[auction] 価格取得失敗 (${title}):`, e.message);
    return;
  }

  if (!auctionMin) return;

  const isOverList = auctionMin > listPrice;
  const prevOverList = entry.overListPrice === true;

  // ヤフオク相場は内部判断のみ（ユーザー向け通知・プッシュ文言に使わない）
  if (isOverList && !prevOverList) {
    opsJsonLog('auction_internal_over_list_flip', {
      source: 'auction_checker',
      userId: userId ? String(userId).slice(0, 10) : undefined,
      itemHint: itemId ? String(itemId).slice(0, 14) : undefined,
    });
  }

  // Redis の overListPrice フラグを更新
  const hash = itemHashKey(sourceId, itemId);
  const key  = watchKey(userId, hash);
  await r.set(key, JSON.stringify({
    ...entry,
    overListPrice:        isOverList,
    auctionMin:           auctionMin,
    auctionCheckedAt:     Date.now(),
  }), { ex: WATCH_TTL });

  console.log(
    `[auction] ${title}: チェック済み overList=${isOverList}`,
  );
}
