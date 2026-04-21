/**
 * POST /api/monitor  — 見守りアイテム登録
 * GET  /api/monitor  — ユーザーの見守りアイテムのステータス一覧取得
 *
 * 在庫チェックはこのファイルの checkAllWatched() を
 * index.js のスケジューラーから呼び出す。
 */

import { getRedis, withRedisRetry } from '../lib/redis.js';
import { isNoise } from '../lib/noise-filter.js';
import { extractModelNumbers, extractSizeFromKeyword } from '../lib/cross-validator.js';
import {
  extractColorKeywords,
  expandColorQuery,
  buildSerpPlainTextHaystack,
} from '../lib/color-filter.js';
import { serpItemMatchesRule } from '../lib/serp-item-rule.js';
import { searchAllCached } from '../lib/shop-search-cache.js';
import { sendOneSignalNotification } from '../lib/notification.js';
import { getAuctionMinPrice } from '../lib/auction-checker.js';
import { getStockInterval, getStockIntervalForPlan, CURRENT_PLAN, STOCK_CONFIG } from '../lib/plan-config.js';
import { checkStock } from '../lib/stock-checker.js';
import {
  MONITOR_SCHEMA_VERSION,
  WATCH_TTL,
  GLOBAL_MONITOR_KEYS_SET,
  GLOBAL_MONITOR_KEYS_SET_TTL_SEC,
  watchKey,
  userWatchIndexKey,
  userPlanKey,
  itemHashKey,
  parseMonitorEntriesFromMget,
  isMonitorEntryRedisKey,
  monitorEntryKeysGlobPattern,
  monitorUserEntryKeysPattern,
} from '../lib/monitor-constants.js';

/** node run-cli.mjs からのみ詳細進捗ログ（動的 import 前に RE_EYE_CLI=1 をセット） */
function isRunCli() {
  return process.env.RE_EYE_CLI === '1' || process.env.RE_EYE_CLI === 'true';
}
function cliLog(...args) {
  if (isRunCli()) console.log(...args);
}

/** テスト中: 新着 URL だけでなく、今回の検索ヒット全件に serpItemMatchesRule を適用し合格なら通知。本番前に false へ。 */
const SERP_EVALUATE_ALL_CURRENT_ITEMS_FOR_TEST = true;

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
  const itemId = normalizeWatchId(body.itemId);
  const sourceId = normalizeWatchId(body.sourceId);
  const userId = String(body.userId || '').trim();
  const url = body.url != null ? String(body.url) : '';
  const title = body.title != null ? String(body.title) : '';
  const price = Number(body.price) || 0;
  const plan = body.plan;
  if (!keyword || !itemId || !sourceId || !userId) {
    return res.status(400).json({ error: 'keyword, itemId, sourceId, userId are required' });
  }

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

  const hash = itemHashKey(sourceId, itemId);
  const key = watchKey(userId, hash);

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

/** ユーザーの全見守りアイテムを取得 */
async function handleStatus(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

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

  const { intervalSec } = getStockInterval();
  if (intervalSec === null) {
    console.log('[monitor][VIP] 夜間スリープ期間 — スキップ');
    cliLog('[run-cli] 夜間スリープのため在庫監視はスキップされました');
    return;
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
    const { intervalSec } = getStockIntervalForPlan(plan);
    if (intervalSec === null) return false; // 夜間スキップ対象プラン
    const elapsedSec = (now - (entry.lastCheckedAt || 0)) / 1000;
    return elapsedSec >= intervalSec * 0.85; // 85%経過したらチェック対象（余裕を持たせる）
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
async function runCascadeSearch(keyword, officialTitle) {
  try {
    const expandedKeyword = expandColorQuery(keyword);
    const sizeInfo        = extractSizeFromKeyword(keyword);

    console.log(
      `[CASCADE] 開始: expanded="${expandedKeyword.slice(0, 60)}"` +
      ` size=${sizeInfo ? `${sizeInfo.raw}(${sizeInfo.type})` : 'なし'}`
    );

    const marketResult = await searchAllCached(expandedKeyword, {
      maxResults: 10,
      inStockOnly: false,
      cacheTtlSec: 120,
    });
    const marketItems = marketResult.items || [];

    const available = marketItems.filter(i => i.available && (i.price || 0) > 0);
    const cheapest  = available.length > 0
      ? available.reduce((a, b) => (a.price || 0) <= (b.price || 0) ? a : b)
      : null;
    const marketFound = cheapest !== null;

    const parts = [];
    if (cheapest) parts.push(`楽天・Yahoo最安 ¥${cheapest.price.toLocaleString()}`);
    const cascadeText = parts.length > 0 ? ` / ${parts.join(' / ')}` : '';

    console.log(`[CASCADE] 結果: 楽天・Yahoo在庫ヒット ${available.length}件 marketFound=${marketFound}`);

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
 * Yahoo は親 SKU で inStock=false でも、説明にサイズ選択・在庫表記があることがある。
 */
function yahooSelectableStockHeuristic(item) {
  if (item.sourceId !== 'yahoo' || item.available !== false) return false;
  const hay = buildSerpPlainTextHaystack(item);
  const d = hay.toLowerCase();
  if (/売り切れ|在庫なし|完売|販売終了|取扱終了|取り扱い終了|品切れ/.test(d)) return false;
  if (
    /在庫あり|△|〇|ご購入いただけ|カートに入れ|バリエーション|サイズ.*選択|選択.*サイズ|選べるサイズ|オプションで|カラー.*サイズ|サイズ・カラー/.test(
      d
    )
  ) {
    return true;
  }
  return false;
}

/**
 * serpUrls: Redis に保存する「前回検索時の URL セット」（最大100件）
 */
async function checkAndNotifySerp(r, entry) {
  const { keyword, userId, itemId, sourceId, title, listPrice } = entry;
  const label = (title || keyword || itemId || '?').slice(0, 56);

  // ── Step 1–2: 色展開クエリで楽天・Yahoo のみ検索（Google / SerpAPI は未使用）────
  const expandedKeyword = expandColorQuery(keyword);
  const sizeInfo        = extractSizeFromKeyword(keyword);

  console.log(
    `[SERP] "${keyword.slice(0, 40)}" ` +
    `expanded="${expandedKeyword.slice(0, 50)}" ` +
    `size=${sizeInfo ? `${sizeInfo.raw}(${sizeInfo.type})` : 'なし'}`
  );

  const marketResult = await searchAllCached(expandedKeyword, {
    maxResults: 20,
    inStockOnly: false,
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
  const allItems = marketItems.filter(i => {
    if (!i.url) return false;
    if (seenUrls.has(i.url)) return false;
    seenUrls.add(i.url);
    return true;
  });

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
    `[SERP] 現在${currentUrls.length}件 前回${prevUrls.length}件 新着${newItems.length}件` +
    (SERP_EVALUATE_ALL_CURRENT_ITEMS_FOR_TEST ? ' [テスト: 全ヒットを判定・通知候補]' : '')
  );

  if (!SERP_EVALUATE_ALL_CURRENT_ITEMS_FOR_TEST && newItems.length === 0) {
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

  /** 通常は新着のみ。テスト時は検索に載っている全商品をサイズ・品番判定する。 */
  const itemsToEvaluate = SERP_EVALUATE_ALL_CURRENT_ITEMS_FOR_TEST ? allItems : newItems;

  const confirmed = [];

  for (const item of itemsToEvaluate.slice(0, 30)) {
    if (isNoise(item)) {
      console.log(`[SERP] ノイズ: "${item.title?.slice(0, 40)}"`);
      continue;
    }

    const itemPrice = item.price || 0;
    if (listPrice > 0 && itemPrice > 0) {
      const ratio = itemPrice / listPrice;
      if (ratio < 0.5 || ratio > 2.5) {
        console.log(`[SERP] 価格異常: ¥${itemPrice} / 参考¥${listPrice}`);
        continue;
      }
    }

    if (!serpItemMatchesRule(entry, item)) continue;

    let stockConfirmed = item.available !== false;
    if (!stockConfirmed && yahooSelectableStockHeuristic(item)) {
      stockConfirmed = true;
      console.log('[SERP] Yahoo: inStock=false でも説明・キャッチに購入/バリエーション表記あり → 在庫ありとみなす');
    }
    if (isOfficialUrl(item.url)) {
      const sr = await checkStock(item.url, keyword);
      stockConfirmed = sr.status === 'in_stock';
    }
    if (!stockConfirmed) {
      console.log(`[SERP] 在庫なし: ${item.url?.slice(0, 60)}`);
      continue;
    }

    confirmed.push({ item });
    console.log(`[SERP] ✅ 合格: "${item.title?.slice(0, 50)}" ¥${itemPrice.toLocaleString()} ${item.url?.slice(0, 50)}`);
  }

  for (const { item } of confirmed) {
    const itemPrice = item.price || 0;
    const sizeInfo  = extractSizeFromKeyword(keyword);
    const sizeLine  = sizeInfo?.raw ? `サイズ:${sizeInfo.raw}` : '';
    let siteLine    = '';
    try {
      siteLine = new URL(item.url).hostname.replace(/^www\./, '');
    } catch { /* ok */ }
    const msgBody = [
      item.title?.slice(0, 52),
      `¥${itemPrice.toLocaleString()}`,
      sizeLine,
      siteLine,
    ].filter(Boolean).join(' · ');
    try {
      await sendOneSignalNotification({
        title:   `[新着在庫] ${title || keyword}`,
        message: msgBody,
        url:     item.url,
        data: {
          type:    'serp_new',
          userId,
          itemUrl: item.url,
          keyword,
          shop:    item.sourceId || '',
        },
      });
    } catch(e) {
      console.error('[SERP] OneSignal 通知失敗:', e.message);
    }
  }

  // ── Step 6: 状態を更新（GET /api/monitor・フロントが参照する status / url / price / results）────
  const hash = itemHashKey(sourceId, itemId);
  const resultsPayload =
    confirmed.length > 0
      ? confirmed.map(({ item: it }) => ({
          title:     it.title || '',
          url:       it.url || '',
          price:     Number(it.price) || 0,
          sourceId:  it.sourceId || '',
          itemId:    String(it.itemId || ''),
          shopName:  it.shopName || '',
          available: it.available !== false,
          matchedAt: Date.now(),
        }))
      : undefined;
  const primary = confirmed[0]?.item;

  await r.set(
    watchKey(userId, hash),
    JSON.stringify({
      ...entry,
      serpUrls:      currentUrls.slice(0, 100),
      lastCheckedAt: Date.now(),
      schemaVersion: MONITOR_SCHEMA_VERSION,
      ...(confirmed.length > 0
        ? {
            notifiedAt: Date.now(),
            status:     'ON',
            results:    resultsPayload,
            // 監視行の代表リンク（シードのプレースホルダ URL を実ヒットで上書き）
            url:   primary?.url || entry.url,
            price: Number(primary?.price) || entry.price || 0,
          }
        : {}),
    }),
    { ex: WATCH_TTL }
  );

  let outcome;
  if (searchErrs.length) {
    outcome = confirmed.length > 0
      ? `通知あり（${confirmed.length}件）※検索APIエラーあり`
      : '在庫なし・通知なし ※検索APIエラーあり';
  } else if (confirmed.length > 0) {
    outcome = `通知あり（${confirmed.length}件）`;
  } else {
    outcome = '在庫なし（新着はノイズ・不一致・在庫なしで除外）';
  }
  return {
    label,
    outcome,
    detail: searchErrs.length ? searchErrs.join('; ') : undefined,
  };
}

// ─────────────────────────────────────────────────────────
//  公式URL特権パス: 全フィルタースキップ + 全方位波及検索
// ─────────────────────────────────────────────────────────

/**
 * 公式ドメインのアイテムを直接フェッチして在庫確認・通知する。
 *
 * 2軸状態管理:
 *   officialStatus: 'ON'|'OFF' — 公式サイトの在庫状態
 *   marketStatus:   'FOUND'|'NOT_FOUND' — 楽天・Yahoo・専門店での発見状態
 *
 * 通知トリガー:
 *   1. officialStatus が変化した時
 *   2. officialStatus が OFF のまま、marketStatus が NOT_FOUND→FOUND に変化した時
 *      （「公式は品切れだが、専門店で在庫発見」）
 */
async function checkOfficialAndNotify(r, entry, lastStatus) {
  const { url, keyword, title, price, listPrice, userId, itemId, sourceId } = entry;
  const label = (title || keyword || '?').slice(0, 56);

  console.log(`[monitor][公式特権] "${title?.slice(0, 40)}" → 直接フェッチ: ${url.slice(0, 60)}`);
  const stockResult = await checkStock(url, keyword || '');

  // エラー / 判定不能 → タイムスタンプ更新のみ
  if (stockResult.status === 'error' || stockResult.status === 'unknown') {
    console.log(`[monitor][公式] 判定不能(${stockResult.status}): ${url.slice(0, 60)}`);
    const hash = itemHashKey(sourceId, itemId);
    await r.set(watchKey(userId, hash), JSON.stringify({
      ...entry, lastCheckedAt: Date.now(), schemaVersion: MONITOR_SCHEMA_VERSION,
    }), { ex: WATCH_TTL });
    return { label, outcome: 'エラー', detail: `公式在庫判定: ${stockResult.status}` };
  }

  const newStatus    = stockResult.status === 'in_stock' ? 'ON' : 'OFF';
  const isRestocked  = newStatus === 'ON';

  // ── 全方位波及検索（公式の在庫状況に関わらず常に実行）───────────────────────
  // 公式が品切れでも楽天・専門店を意地でも探す。
  const cascade = await runCascadeSearch(keyword, title);

  // ── 2軸状態変化の判定 ─────────────────────────────────────────────────────
  const prevMarketStatus = entry.marketStatus || 'NOT_FOUND';
  const newMarketStatus  = cascade.marketFound ? 'FOUND' : 'NOT_FOUND';

  const officialChanged = newStatus !== lastStatus;
  const marketChanged   = newMarketStatus !== prevMarketStatus;

  // 変化なし → タイムスタンプ + marketStatus のみ更新
  if (!officialChanged && !marketChanged) {
    const hash = itemHashKey(sourceId, itemId);
    await r.set(watchKey(userId, hash), JSON.stringify({
      ...entry,
      lastCheckedAt: Date.now(),
      marketStatus:  newMarketStatus,
      schemaVersion: MONITOR_SCHEMA_VERSION,
    }), { ex: WATCH_TTL });
    let outcomeNoChange;
    if (newStatus === 'ON') outcomeNoChange = '変化なし（公式在庫あり）';
    else if (newMarketStatus === 'FOUND') outcomeNoChange = '変化なし（公式品切れ・市場在庫あり）';
    else outcomeNoChange = '変化なし（在庫なし）';

    return {
      label,
      outcome: outcomeNoChange,
      detail:  `公式=${newStatus} 市場=${newMarketStatus}`,
    };
  }

  let notifTitle, notifMessage, notifUrl;

  if (officialChanged && isRestocked) {
    notifTitle   = `[公式入荷] ${title}`;
    notifMessage = `公式サイトで在庫を確認${cascade.cascadeText}`;
    notifUrl     = url;

  } else if (officialChanged && !isRestocked) {
    if (cascade.marketFound) {
      notifTitle   = `[公式品切れ | 楽天・Yahoo在庫あり] ${title}`;
      notifMessage = `公式は品切れ。${cascade.cascadeText.replace(' / ', '')}`;
      notifUrl     = cascade.cheapest?.url || undefined;
    } else {
      notifTitle   = `${title} 品切れ（公式・楽天・Yahoo確認）`;
      notifMessage = '公式・楽天市場・Yahoo!ショッピングで該当在庫なし。引き続き監視します。';
      notifUrl     = undefined;
    }

  } else {
    notifTitle   = `[発見] ${title} — 楽天・Yahooで在庫あり`;
    notifMessage = `公式は品切れ中。${cascade.cascadeText.replace(' / ', '')}`;
    notifUrl     = cascade.cheapest?.url || undefined;
  }

  try {
    await sendOneSignalNotification({
      title:   notifTitle,
      message: notifMessage,
      url:     notifUrl,
      data: {
        type:     isRestocked ? 'official_restock' : (cascade.marketFound ? 'market_found' : 'soldout'),
        itemId, sourceId, userId,
        newStatus, marketStatus: newMarketStatus,
        itemUrl: url, keyword,
      },
    });
  } catch(e) {
    console.error('[monitor][公式] OneSignal 通知失敗:', e.message);
  }

  const hash = itemHashKey(sourceId, itemId);
  await r.set(watchKey(userId, hash), JSON.stringify({
    ...entry,
    status:        newStatus,
    marketStatus:  newMarketStatus,
    lastCheckedAt: Date.now(),
    notifiedAt:    Date.now(),
    schemaVersion: MONITOR_SCHEMA_VERSION,
  }), { ex: WATCH_TTL });

  console.log(
    `[monitor][公式] 通知: "${notifTitle.slice(0, 60)}"` +
    ` official=${newStatus} market=${newMarketStatus}`
  );

  return {
    label,
    outcome: '通知送信',
    detail:  `公式=${newStatus} 市場=${newMarketStatus}`,
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

  // 状態変化がある場合のみ通知（定価超えになった瞬間だけ）
  if (isOverList && !prevOverList) {
    try {
      await sendOneSignalNotification({
        title:   `${title} — 中古相場が定価を超えました`,
        message: `ヤフオク最安値 ¥${auctionMin.toLocaleString()} ／ 定価 ¥${listPrice.toLocaleString()}`,
        data: {
          type:       'auction_over_list',
          itemId,
          sourceId,
          userId,
          auctionMin,
          listPrice,
          keyword,
        },
      });
    } catch(e) {
      console.error('[auction] OneSignal 通知失敗:', e.message);
    }
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

  console.log(`[auction] ${title}: ヤフオク最安 ¥${auctionMin.toLocaleString()} / 定価 ¥${listPrice.toLocaleString()} → ${isOverList ? '⚠️ 定価超え' : 'OK'}`);
}
