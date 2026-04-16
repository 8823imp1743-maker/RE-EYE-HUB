/**
 * POST /api/monitor  — 見守りアイテム登録
 * GET  /api/monitor  — ユーザーの見守りアイテムのステータス一覧取得
 *
 * 在庫チェックはこのファイルの checkAllWatched() を
 * index.js のスケジューラーから呼び出す。
 */

import { createHash } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getRedis } from '../lib/redis.js';
import { validateSizeMatch } from '../lib/user-size.js';
import { isNoise } from '../lib/noise-filter.js';
// checkSizeAvailableOnPage は廃止 — JSDOM はJS動的ページに無力のため削除
// 代替: crossValidateStock（Yahoo + 楽天市場全体の2軸横断検証）
import { crossValidateStock, extractModelNumbers, extractSizeFromKeyword } from '../lib/cross-validator.js';
import { validateColorMatch, extractColorKeywords, expandColorQuery } from '../lib/color-filter.js';
import { searchGoogleShopping } from '../lib/google-shopping.js';
import { searchAll } from '../lib/shop-adapters/index.js';
import { sendOneSignalNotification } from '../lib/notification.js';
import { getAuctionMinPrice } from '../lib/auction-checker.js';
import { jitterWait, getStockInterval, getStockIntervalForPlan, getGeminiModel, CURRENT_PLAN, STOCK_CONFIG } from '../lib/plan-config.js';
import { aiSizeGenderMatch, generateVibeQueries, aiItemVerify } from '../lib/ai-extractor.js';
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
const MONITOR_SCHEMA_VERSION = '2026-04-14-v11'; // AI目視代行(サイズ性別)+Vibe検索クエリ生成

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

/**
 * Gemini で商品名から定価（MSRP）を推定する。
 * 3秒タイムアウト + サイレントfallback。
 * @param {string} title
 * @returns {Promise<number|null>}  推定定価（円）または null
 */
async function estimateListPrice(title) {
  if (!process.env.GEMINI_API_KEY || !title) return null;
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: getGeminiModel(),
      generationConfig: { maxOutputTokens: 40, temperature: 0.1 },
    });
    const prompt =
      `以下の商品名から日本での新品定価（円）を推定してください。` +
      `わからない場合は null を返してください。JSON数値のみ回答（例: 16500 または null）。\n商品名: ${title}`;
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    const text = result.response.text().trim().replace(/[^0-9null]/g, '');
    if (text === 'null' || text === '') return null;
    const val = parseInt(text, 10);
    return isNaN(val) || val <= 0 ? null : val;
  } catch(e) {
    console.warn('[monitor] 定価推定スキップ:', e.message);
    return null;
  }
}

/** 見守りアイテムを Redis に登録 */
async function handleRegister(req, res) {
  const { keyword, itemId, sourceId, userId, url, title, price, listPrice } = req.body || {};
  if (!keyword || !itemId || !sourceId || !userId) {
    return res.status(400).json({ error: 'keyword, itemId, sourceId, userId are required' });
  }

  // ── 定価（MSRP）の確定 ────────────────────────────────────────
  // 優先度: フロントから送られた listPrice → 登録時 price → Gemini 推定
  let resolvedListPrice = listPrice || price || null;
  if (!resolvedListPrice && title) {
    resolvedListPrice = await estimateListPrice(title);
    if (resolvedListPrice) {
      console.log(`[monitor] Gemini 定価推定: "${title}" → ¥${resolvedListPrice.toLocaleString()}`);
    }
  }

  const r = getRedis();
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
 * Gemini AI フォールバック — ブランド固有の色名を文脈で判定する。
 * 辞書ヒットが0件だった場合のみ呼ばれる（API コスト抑制）。
 * 結果は Redis に TTL 1日でキャッシュ。
 *
 * 例: "Celeste" は "水色" か → 1
 *     "'07 Denim" は "ブルー" か → 1
 *     "Midnight" は "ピンク" か → 0
 */
async function geminiColorFallback(r, itemTitle, userColorWord) {
  if (!process.env.GEMINI_API_KEY || !itemTitle || !userColorWord) return false;

  // ── キャッシュ確認 ──────────────────────────────────────────────────
  const cacheKey = `color:ai:${createHash('sha256')
    .update(`${userColorWord}:${itemTitle.slice(0, 80)}`)
    .digest('hex')
    .slice(0, 16)}`;
  try {
    const cached = await r.get(cacheKey);
    if (cached !== null) {
      console.log(`[color-ai] キャッシュヒット: "${userColorWord}" → ${cached === '1' ? '一致' : '不一致'}`);
      return cached === '1';
    }
  } catch { /* キャッシュミスはサイレント */ }

  // ── Gemini に問い合わせ（2.5秒タイムアウト）──────────────────────
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: getGeminiModel(),
      generationConfig: { maxOutputTokens: 5, temperature: 0 },
    });
    const prompt =
      `商品タイトル「${itemTitle.slice(0, 100)}」に含まれる色は` +
      `「${userColorWord}」系の色と言えますか？1か0だけで答えてください（1=はい、0=いいえ）。`;

    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
    ]);
    const answer = result.response.text().trim().charAt(0);
    const isMatch = answer === '1';

    // キャッシュに保存（TTL 1日）
    try { await r.set(cacheKey, isMatch ? '1' : '0', { ex: 86400 }); } catch { /* ok */ }

    console.log(`[color-ai] Gemini判定: "${userColorWord}" × "${itemTitle.slice(0, 50)}" → ${isMatch ? '✅ 一致' : '❌ 不一致'}`);
    return isMatch;
  } catch(e) {
    console.warn('[color-ai] Gemini 色判定スキップ:', e.message);
    return false; // タイムアウト時は安全側（破棄）
  }
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
 *
 * 軸1: 楽天・Yahoo（色同義語展開クエリ — 水色→ライトブルー/celeste 等を自動付加）
 * 軸2: Google Custom Search（35+ TRUSTED_DOMAINS — atmos/ABC-MART/Z-CRAFT 等）
 *
 * 「公式はゴールではなく、正確な品番・色を特定するための基準点。
 *   公式で情報を確定させたら、即座に全市場へ触手を伸ばす。
 *   公式が品切れでも、他のショップを意地でも見つけ出す。」
 *
 * @param {string} keyword       ユーザー登録キーワード
 * @param {string} officialTitle 公式タイトル（品番抽出に使用）
 * @returns {{ cascadeText: string, marketFound: boolean, cheapest: object|null, googleFound: boolean }}
 */
async function runCascadeSearch(keyword, officialTitle) {
  try {
    // 色同義語を展開: "水色" → "水色 ライトブルー celeste"
    const expandedKeyword = expandColorQuery(keyword);

    // 品番抽出: Google の検索軸に使う（品番なし = キーワードをそのまま）
    const models     = extractModelNumbers(officialTitle || keyword);
    const fallbackGoogleTerm = models.length > 0
      ? `${models[0]} ${expandedKeyword}` // 例: "CW2288-111 水色 ライトブルー celeste 26.5cm"
      : expandedKeyword;
    const sizeInfo   = extractSizeFromKeyword(keyword);

    // ── Vibe クエリ生成: Chrome で監督が打つような検索クエリを Gemini が生成 ──────
    // 「品番+色（日英）+サイズ（cm/US両方）+在庫意図ワード」を最適に組み合わせる。
    // キャッシュ済みなら即返却（API コストなし）。
    const vibeQueries = await generateVibeQueries(keyword, 1);
    const googleTerm  = vibeQueries[0] || fallbackGoogleTerm;

    console.log(
      `[CASCADE] 開始: expanded="${expandedKeyword.slice(0, 60)}"` +
      ` vibe="${googleTerm.slice(0, 60)}" size=${sizeInfo ? `${sizeInfo.raw}(${sizeInfo.type})` : 'なし'}`
    );

    // 並列: 楽天+Yahoo（色展開）+ Google 35専門店（Vibe クエリ）を同時スキャン
    const [marketResult, googleResult] = await Promise.allSettled([
      searchAll(expandedKeyword, { maxResults: 10, inStockOnly: false }),
      searchGoogleShopping(googleTerm, null), // Vibe クエリはサイズ込みで生成済み → sizeInfo 不要
    ]);

    const marketItems  = marketResult.status === 'fulfilled' ? (marketResult.value.items || []) : [];
    const googleData   = googleResult.status === 'fulfilled'  ? googleResult.value : { signal: 'error', items: [] };
    const gSignal      = googleData.signal;
    const googleItems  = googleData.items || [];

    // 楽天・Yahoo + Google Shopping を統合して最安値を探す
    const allCascadeItems = [...marketItems, ...googleItems];
    const available  = allCascadeItems.filter(i => i.available && (i.price || 0) > 0);
    const cheapest   = available.length > 0
      ? available.reduce((a, b) => (a.price || 0) <= (b.price || 0) ? a : b)
      : null;
    const googleFound = ['size_confirmed_in_stock', 'market_found'].includes(gSignal);
    const marketFound = cheapest !== null || googleFound;

    // 通知メッセージ用テキストを組み立て
    const parts = [];
    if (cheapest) parts.push(`楽天・Yahoo最安 ¥${cheapest.price.toLocaleString()}`);
    if (googleFound) parts.push('専門店在庫あり(atmos/ABC-MART等)');
    const cascadeText = parts.length > 0 ? ` / ${parts.join(' / ')}` : '';

    console.log(
      `[CASCADE] 結果: 楽天Yahoo在庫${available.length}件` +
      ` Google=${gSignal} marketFound=${marketFound}`
    );

    return { cascadeText, marketFound, cheapest, googleFound };
  } catch(e) {
    console.warn('[CASCADE] 波及検索失敗:', e.message);
    return { cascadeText: '', marketFound: false, cheapest: null, googleFound: false };
  }
}

// ─────────────────────────────────────────────────────────
//  V11: SERP監視メインエンジン（リサーチ起点型）
// ─────────────────────────────────────────────────────────

/**
 * 【V11: 大転換】SERP（検索結果）監視エンジン
 *
 * 設計思想:
 *   「特定URLの生死を確認する」監視から
 *   「検索結果に新しいショップが現れた瞬間を検知する」監視へ。
 *
 * 監視クエリ: 品番 + 色（同義語展開）+ サイズ + 性別 = 4軸完全クエリ
 * 検知ロジック: 前回実行時の URL セットと今回の差分を取る
 * 最終確認:    新着URLに対して Gemini が4軸を目視代行 → 合格で直販URLを通知
 *
 * serpUrls: Redis に保存する「前回検索時の URL セット」（最大100件）
 *   undefined → 初回実行 → ベースライン確立（通知なし）
 *   [] 以上   → 差分検知モード
 */
async function checkAndNotifySerp(r, entry) {
  const { keyword, userId, itemId, sourceId, title, listPrice } = entry;
  const registeredModels = entry.modelNumbers || [];
  const registeredColors = entry.colorKeywords || [];

  // ── Step 1: 4軸クエリ構築 ──────────────────────────────────────────────────
  // 色の多重展開（水色 → 水色 ライトブルー celeste）
  const expandedKeyword = expandColorQuery(keyword);
  // Vibe クエリ生成（Chrome で監督が打つようなクエリ）
  const vibeQueries     = await generateVibeQueries(keyword, 1);
  const googleQuery     = vibeQueries[0] || expandedKeyword;
  const sizeInfo        = extractSizeFromKeyword(keyword);

  console.log(
    `[SERP] "${keyword.slice(0, 40)}" ` +
    `expanded="${expandedKeyword.slice(0, 50)}" vibe="${googleQuery.slice(0, 50)}"`
  );

  // ── Step 2: 全方位SERP検索（楽天+Yahoo + Google 35専門店）──────────────────
  const [marketResult, googleResult] = await Promise.allSettled([
    searchAll(expandedKeyword, { maxResults: 20, inStockOnly: false }),
    searchGoogleShopping(googleQuery, null),
  ]);

  const marketItems  = marketResult.status === 'fulfilled' ? (marketResult.value.items || []) : [];
  const googleData   = googleResult.status === 'fulfilled'  ? googleResult.value : { signal: 'error', items: [] };
  const gSignal      = googleData.signal;
  const googleItems  = googleData.items || [];

  // 楽天・Yahoo + Google Shopping を統合（重複URLは除去）
  const seenUrls = new Set();
  const allItems = [...marketItems, ...googleItems].filter(i => {
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
    console.log(`[SERP] ベースライン確立: ${currentUrls.length}件 / Google=${gSignal}`);
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
    `[SERP] 現在${currentUrls.length}件 前回${prevUrls.length}件 新着${newItems.length}件` +
    ` Google=${gSignal}`
  );

  if (newItems.length === 0 && !['size_confirmed_in_stock'].includes(gSignal)) {
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

  // ── Step 4: 新着アイテムを全フィルター + AI4軸で精査 ────────────────────────
  const confirmed = [];

  for (const item of newItems.slice(0, 5)) { // max 5件/回（API コスト制御）

    // ノイズ除去（中古・禁止ドメイン）
    if (isNoise(item)) {
      console.log(`[SERP] ノイズ: "${item.title?.slice(0, 40)}"`);
      continue;
    }

    // 価格比率チェック（定価の50%未満 or 250%超）
    const itemPrice = item.price || 0;
    if (listPrice > 0 && itemPrice > 0) {
      const ratio = itemPrice / listPrice;
      if (ratio < 0.5 || ratio > 2.5) {
        console.log(`[SERP] 価格異常: ¥${itemPrice} / 定価¥${listPrice}`);
        continue;
      }
    }

    // ── AI 4軸完全目視代行 ─────────────────────────────────────────────────
    // 品番 + 色 + サイズ + 性別 を Gemini が一括確認
    // 辞書チェック（品番・色）は AI が内包しているため個別フィルターは通さない
    const aiResult = await aiItemVerify(item.title, keyword, {
      modelNumbers: registeredModels,
      colorKeywords: registeredColors.length > 0 ? registeredColors : extractColorKeywords(keyword),
    });

    if (!aiResult.pass) {
      console.log(`[SERP] 4軸不合格: ${aiResult.reason} "${item.title?.slice(0, 50)}"`);
      continue;
    }

    // 在庫確認
    // 公式URL → 直接フェッチ（ヘッドレスに近いレベルで確認）
    // 楽天・Yahoo → available フラグを信頼
    let stockConfirmed = item.available !== false;
    if (isOfficialUrl(item.url)) {
      const sr = await checkStock(item.url, keyword);
      stockConfirmed = sr.status === 'in_stock';
    }
    if (!stockConfirmed) {
      console.log(`[SERP] 在庫なし: ${item.url?.slice(0, 60)}`);
      continue;
    }

    // VIP AI 分析（中古・プレ値・抱き合わせ）
    let aiAnalysis = null;
    if (process.env.GEMINI_API_KEY) {
      aiAnalysis = await vipAnalyzeRestock({
        title: item.title, price: itemPrice, listPrice: listPrice || 0,
      });
      if (aiAnalysis?.isUsed) {
        console.log(`[SERP][VIP] Gemini中古判定: ${item.title?.slice(0, 40)}`);
        continue;
      }
    }

    confirmed.push({ item, aiAnalysis });
    console.log(`[SERP] ✅ 合格: "${item.title?.slice(0, 50)}" ¥${itemPrice.toLocaleString()} ${item.url?.slice(0, 50)}`);
  }

  // ── Step 5: 合格アイテムを通知（直販URL付き）───────────────────────────────
  for (const { item, aiAnalysis } of confirmed) {
    const badge    = aiAnalysis?.suspicious ? ` ${aiAnalysis.badge}` : '';
    const itemPrice = item.price || 0;
    try {
      await sendOneSignalNotification({
        title:   `[新着在庫]${badge} ${title || keyword}`,
        message: `${item.title?.slice(0, 60)} ¥${itemPrice.toLocaleString()}` +
          (aiAnalysis?.suspicious ? ` ⚠️ ${aiAnalysis.reason}` : ''),
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
    ...(confirmed.length > 0 ? { notifiedAt: Date.now() } : {}),
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

  // ── VIP AI 分析（入荷時のみ）────────────────────────────────────────────
  let aiAnalysis = null;
  if (isRestocked || (cascade.marketFound && !isRestocked)) {
    aiAnalysis = await vipAnalyzeRestock({ title, price, listPrice: listPrice || 0 });
    if (aiAnalysis?.isUsed) {
      console.log(`[monitor][公式][VIP] 🚫 Gemini中古判定でブロック: ${title}`);
      return;
    }
  }

  const suspiciousBadge = aiAnalysis?.suspicious ? ` ${aiAnalysis.badge}` : '';

  // ── 通知メッセージの組み立て（3パターン）────────────────────────────────────
  let notifTitle, notifMessage, notifUrl;

  if (officialChanged && isRestocked) {
    // パターン1: 公式に在庫が出た（最優先通知）
    notifTitle   = `[公式入荷]${suspiciousBadge} ${title}`;
    notifMessage = `公式サイトで在庫を確認${cascade.cascadeText}` +
      (aiAnalysis?.suspicious ? ` ⚠️ ${aiAnalysis.reason}` : '');
    notifUrl     = url;

  } else if (officialChanged && !isRestocked) {
    if (cascade.marketFound) {
      // パターン2: 公式は品切れになったが、専門店・楽天に在庫あり
      notifTitle   = `[公式品切れ | 専門店在庫あり]${suspiciousBadge} ${title}`;
      notifMessage = `公式は品切れ。${cascade.cascadeText.replace(' / ', '')}` +
        (aiAnalysis?.suspicious ? ` ⚠️ ${aiAnalysis.reason}` : '');
      notifUrl     = cascade.cheapest?.url || undefined;
    } else {
      // パターン3: 公式・市場すべて品切れ
      notifTitle   = `${title} 品切れ（公式・全市場確認）`;
      notifMessage = '公式・楽天・Yahoo・専門店すべてで在庫なし。引き続き監視します。';
      notifUrl     = undefined;
    }

  } else {
    // パターン4: 公式は引き続き品切れ だが 専門店・楽天で新たに在庫発見
    // （officialChanged=false & marketChanged=true & marketFound=true）
    notifTitle   = `[発見] ${title} — 専門店/市場で在庫あり`;
    notifMessage = `公式は品切れ中。${cascade.cascadeText.replace(' / ', '')}` +
      (aiAnalysis?.suspicious ? ` ⚠️ ${aiAnalysis.reason}` : '');
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
 * VIP AI 分析: 入荷検知時に「抱き合わせ」「プレ値」を Gemini で判定する。
 * @returns {{ suspicious: boolean, badge: string, reason: string } | null}
 */
async function vipAnalyzeRestock({ title, price, listPrice }) {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: getGeminiModel() });
    const prompt = `あなたは転売・中古品・抱き合わせ販売の専門アナリストです。
以下の商品情報を分析し、JSON のみで回答してください（説明文は不要）。

商品名: ${title}
現在価格: ¥${price?.toLocaleString() ?? '不明'}
${listPrice ? `定価: ¥${listPrice.toLocaleString()}` : ''}

判定項目:
1. 中古品・リユース品の疑い（タイトルや価格から中古・USED・美品・コンディション等を示す語があるか。または価格が定価の30%未満の場合も中古の可能性大）
2. 抱き合わせ販売の疑い（タイトルに「セット」「まとめ」「＋」など複数商品を示す語があるか）
3. プレ値の疑い（現在価格が定価の1.3倍以上か、または「プレミア」「希少」などの語があるか）
4. 偽装入荷の疑い（「予約」「転売」「仕入れ」などリセール目的を示す語があるか）

重要: 中古品の疑いがある場合は必ず isUsed: true にすること。

回答フォーマット:
{"isUsed": true/false, "suspicious": true/false, "badge": "⚠️ 中古品疑惑" または "⚠️ 抱き合わせ疑惑" または "⚠️ プレ値疑惑" または "⚠️ 偽装入荷疑惑" または "", "reason": "理由を20字以内で"}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const json = text.replace(/```json|```/g, '').trim();
    return JSON.parse(json);
  } catch(e) {
    console.error('[monitor][VIP] AI分析失敗:', e.message);
    return null;
  }
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
