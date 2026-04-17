/**
 * POST /api/monitor  — 見守りアイテム登録
 * GET  /api/monitor  — ユーザーの見守りアイテムのステータス一覧取得
 *
 * 在庫チェックはこのファイルの checkAllWatched() を
 * index.js のスケジューラーから呼び出す。
 */

import { createHash } from 'crypto';
import { getRedis } from '../lib/redis.js';
import { isNoise } from '../lib/noise-filter.js';
import { extractModelNumbers, extractSizeFromKeyword } from '../lib/cross-validator.js';
import { validateColorMatchForItem, extractColorKeywords, expandColorQuery } from '../lib/color-filter.js';
import { matchesProductKeyword } from '../lib/keyword-match.js';
import { normalizeBrand } from '../lib/brand-normalizer.js';
import { searchAllCached } from '../lib/shop-search-cache.js';
import { sendOneSignalNotification } from '../lib/notification.js';
import { getAuctionMinPrice } from '../lib/auction-checker.js';
import { jitterWait, getStockInterval, getStockIntervalForPlan, CURRENT_PLAN, STOCK_CONFIG } from '../lib/plan-config.js';
import { checkStock } from '../lib/stock-checker.js';

const WATCH_TTL = 60 * 60 * 24 * 90; // 90日

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
 * スキーマバージョン — ここを変更すると全 Redis エントリを「未確認」扱いにリセットする。
 * 新しいフィルター（サイズチェッカー超・冷徹モード等）導入後は必ずバージョンを上げる。
 */
const MONITOR_SCHEMA_VERSION = '2026-04-18-v12'; // ルールベースのみ（Gemini 排除）

/** Redis キー生成 */
function watchKey(userId, hash) {
  return `monitor:${userId}:${hash}`;
}

function itemHashKey(sourceId, itemId) {
  return createHash('sha256')
    .update(`${sourceId}:${itemId}`)
    .digest('hex')
    .slice(0, 16);
}

// ─────────────────────────────────────────────────────────
//  HTTP ハンドラー
// ─────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'POST') return handleRegister(req, res);
  if (req.method === 'GET')  return handleStatus(req, res);
  return res.status(405).json({ error: 'Method Not Allowed' });
}

/** プランのみ Redis に同期（見守り画面の選択をサーバ監視間隔に反映） */
async function handlePlanSyncOnly(req, res) {
  const { userId, plan } = req.body || {};
  if (!userId || !plan || !STOCK_CONFIG[plan]) {
    return res.status(400).json({ error: 'userId and valid plan required' });
  }
  const r = getRedis();
  await r.set(`user:plan:${userId}`, plan, { ex: WATCH_TTL });
  return res.status(200).json({ ok: true, plan });
}

/** 見守りアイテムを Redis に登録 */
async function handleRegister(req, res) {
  const body = req.body || {};
  if (body.syncPlanOnly) {
    return handlePlanSyncOnly(req, res);
  }
  const { keyword, itemId, sourceId, userId, url, title, price, listPrice, plan } = body;
  if (!keyword || !itemId || !sourceId || !userId) {
    return res.status(400).json({ error: 'keyword, itemId, sourceId, userId are required' });
  }

  let resolvedListPrice = listPrice || price || 0;

  const r = getRedis();
  if (plan && STOCK_CONFIG[plan]) {
    await r.set(`user:plan:${userId}`, plan, { ex: WATCH_TTL });
  }
  const hash = itemHashKey(sourceId, itemId);
  const key  = watchKey(userId, hash);

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
    keyword, itemId, sourceId, userId,
    url:           url   || '',
    title:         registeredTitle,
    price:         price || 0,
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

  await r.set(key, JSON.stringify(entry), { ex: WATCH_TTL });
  return res.status(200).json({
    registered:    true,
    hash,
    listPrice:     resolvedListPrice,
    modelNumbers:  registeredModels,   // 登録確定品番
    colorKeywords: registeredColors,   // 登録確定色キーワード
  });
}

/** ユーザーの全見守りアイテムを取得 */
async function handleStatus(req, res) {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    const items = await getUserWatchItems(userId);
    return res.status(200).json({ items });
  } catch(e) {
    return res.status(500).json({ items: [], error: e.message });
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
 * キー: user:plan:{userId}  値: 'FREE'|'STANDARD'|'PRO'|'VIP'
 * 未設定の場合は CURRENT_PLAN を返す。
 */
async function getUserPlanBatch(r, userIds) {
  if (userIds.length === 0) return {};
  const planKeys = userIds.map(uid => `user:plan:${uid}`);
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
 * index.js の Cron から呼び出す
 */
export async function checkAllWatched() {
  // ── VIP Jitter: 実行タイミングをランダムにずらして bot 検知を回避 ──────
  const { intervalSec, jitterSec } = getStockInterval();
  if (intervalSec === null) {
    console.log('[monitor][VIP] 夜間スリープ期間 — スキップ');
    return;
  }
  if (jitterSec > 0) {
    const waitSec = 30 + Math.floor(Math.random() * 31); // 30–60秒のランダム待機
    console.log(`[monitor][VIP] Jitter 待機: ${waitSec}秒`);
    await jitterWait(waitSec, 0);
  }

  const r = getRedis();
  let keys = [];
  try {
    keys = await r.keys('monitor:*');
  } catch(e) {
    console.error('[monitor] KEYS エラー:', e.message);
    return;
  }

  if (keys.length === 0) return;

  const values = await r.mget(...keys);
  const allEntries = values
    .filter(Boolean)
    .map(v => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean);

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

  // アイテムごとに現在の在庫を確認（並列数 5 に制限 — API Rate Limit 対策）
  const CONCURRENCY = 5;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(entry => checkAndNotify(r, entry)));
    // バッチ間に 1 秒のインターバルを挟んで連続リクエストを緩和
    if (i + CONCURRENCY < entries.length) {
      await new Promise(res => setTimeout(res, 1000));
    }
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
 * 新着商品が監視キーワード・色・品番と整合するか（プログラム判定）
 */
function serpItemMatchesRule(entry, item) {
  const keyword = entry.keyword || '';
  const normalized = normalizeBrand(keyword);
  if (!validateColorMatchForItem(item, keyword)) {
    console.log(`[SERP] 色不一致スキップ: "${(item.title || '').slice(0, 45)}"`);
    return false;
  }
  const models = entry.modelNumbers || [];
  if (models.length > 0) {
    const t = (item.title || '').toUpperCase();
    const ok = models.some(m => t.includes(String(m).toUpperCase()));
    if (!ok) {
      console.log(`[SERP] 品番不一致スキップ: need [${models.join(',')}]`);
      return false;
    }
  }
  if (!matchesProductKeyword(item, keyword, normalized)) {
    console.log(`[SERP] 商品名キーワード不一致: "${(item.title || '').slice(0, 45)}"`);
    return false;
  }
  return true;
}

/**
 * serpUrls: Redis に保存する「前回検索時の URL セット」（最大100件）
 */
async function checkAndNotifySerp(r, entry) {
  const { keyword, userId, itemId, sourceId, title, listPrice } = entry;

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
    return;
  }

  const newItems = allItems.filter(i => i.url && !prevUrls.includes(i.url));

  console.log(
    `[SERP] 現在${currentUrls.length}件 前回${prevUrls.length}件 新着${newItems.length}件`
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
    return;
  }

  const confirmed = [];

  for (const item of newItems.slice(0, 5)) {
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

  // ── Step 6: 状態を更新 ──────────────────────────────────────────────────────
  const hash = itemHashKey(sourceId, itemId);
  await r.set(watchKey(userId, hash), JSON.stringify({
    ...entry,
    serpUrls:      currentUrls.slice(0, 100),
    lastCheckedAt: Date.now(),
    ...(confirmed.length > 0 ? { notifiedAt: Date.now(), status: 'ON' } : {}),
    schemaVersion: MONITOR_SCHEMA_VERSION,
  }), { ex: WATCH_TTL });
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

  console.log(`[monitor][公式特権] "${title?.slice(0, 40)}" → 直接フェッチ: ${url.slice(0, 60)}`);
  const stockResult = await checkStock(url, keyword || '');

  // エラー / 判定不能 → タイムスタンプ更新のみ
  if (stockResult.status === 'error' || stockResult.status === 'unknown') {
    console.log(`[monitor][公式] 判定不能(${stockResult.status}): ${url.slice(0, 60)}`);
    const hash = itemHashKey(sourceId, itemId);
    await r.set(watchKey(userId, hash), JSON.stringify({
      ...entry, lastCheckedAt: Date.now(), schemaVersion: MONITOR_SCHEMA_VERSION,
    }), { ex: WATCH_TTL });
    return;
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
    return;
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
    console.log(`[monitor] スキーマバージョン不一致 → lastStatus を 'OFF' にリセット (entry="${title?.slice(0,40)}")`);
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
  const keys = await r.keys(`monitor:${userId}:*`);
  if (keys.length === 0) return [];
  const values = await r.mget(...keys);
  return values
    .filter(Boolean)
    .map(v => { try { return JSON.parse(v); } catch { return null; } })
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
    keys = await r.keys('monitor:*');
  } catch(e) {
    console.error('[auction] KEYS エラー:', e.message);
    return;
  }
  if (keys.length === 0) return;

  const values = await r.mget(...keys);
  const entries = values
    .filter(Boolean)
    .map(v => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean);

  // 定価が登録されているアイテムのみ対象
  const targets = entries.filter(e => e.price && e.price > 0);
  console.log(`[auction] 対象アイテム ${targets.length} 件`);

  // 連続リクエストを避けるため直列処理（1秒インターバル）
  for (const entry of targets) {
    await checkAuctionAndNotify(r, entry);
    await new Promise(res => setTimeout(res, 1000));
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
