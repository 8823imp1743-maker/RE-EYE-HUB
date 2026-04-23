/**
 * POST /api/search
 * 在庫検索 — 方針:
 *  - 楽天・Yahoo へのクエリに cm / プロファイル由来のサイズを混ぜない
 *  - 品番が取れたら API は品番のみ。なければメーカー＋商品名（cm 抜き）
 *  - 靴＋マイ cm: 段階先読み — 1リクエストあたり表示10＋次の1件=最大11在庫確定、PDP 呼び出し最大11、モールは最大3ページ/回
 *  - ページング: prePdpScanIndex / offset / excludeKeys / excludeSellerModelKeys / nextStartingItem(バトン)
 *
 * YouTube 型の「コスト平準化」: フロントは sequentialPdp で **短い 1 回ずつ** /api/search を呼び、1 当たりの PDP(HTTP) 回数を抑える（サーバ上の pdp-shoe-stock と時間を小分け）。
 * 厳密に「商品 PDP の HTML 解析を利用者端末へ」置くことは、楽天/Yahoo 等の **CORS 制約**でブラウザ直 fetch が通らないため、**PDP 取得は自サーバ経由が前提**。サーバは重い一括ループを避け、1 区切り・短タイムアウトで 10s 壁を下回る設計を意識する。
 */

import { loadUserSettings, getUserShoeCmRawForPostFilter, genresForKeyword } from '../lib/user-size.js';
import { sanitizeUserId } from '../lib/user-settings.js';
import {
  buildMallSearchKeywordList,
  stripSizeCmFromDisplayKeyword,
  stripModelCodesAndSizeForNameQuery,
  normalizeBrand,
} from '../lib/stock-search-query.js';
import { extractModelNumbers, hasSizeInTitleUniversal } from '../lib/cross-validator.js';
import { buildSerpPlainTextHaystack, validateColorMatchForItem } from '../lib/color-filter.js';
import { matchesProductKeyword } from '../lib/keyword-match.js';
import { collectPdpShoeVerifies } from '../lib/pdp-shoe-stock.js';
import { itemCanonicalKey, sellerModelDedupeKey } from '../lib/stock-dedupe.js';
import { fetchMallPageSliceForKeywordList, pushUniqueMallItems } from '../lib/search-mall-fetch.js';

const HITS_PER_PAGE = 20;
/** 一覧のみ（非PDP）: 1リクエストあたり取得するモールページ上限 */
const MAX_MALL_PAGE = 5;
/** 靴PDP: 1 API 当たりにめくるモールページ数（1区切り＝最大3ページ・一覧を満たすまで） */
const MAX_MALL_PAGE_PER_STAGED_REQUEST = 3;
/**
 * 順次 PD P モード（フロントがポン積み）: 1 回の serverless から捌くモールページを抑え、
 * Vercel 無料枠内で YouTube 的に小刻みに回す。0 品になるリスクを避けつつ 3 未満にする折衷。
 */
const MAX_MALL_PAGE_SEQUENTIAL = 2;
/** 1リクエストで在庫確定を狙う件数: 10 表示 + 1 次バトン */
const STOCK_DISPLAY = 10;
const STOCK_SEEK_PEEK = 1;
const STOCK_CHUNK_SEEK = STOCK_DISPLAY + STOCK_SEEK_PEEK; // 11
/** 順次1件モード: 1表示 + 予備0（1リクエスト=PDP1回目安、503 回避用） */
const STOCK_SEQUENTIAL_DISPLAY = 1;
const STOCK_SEQUENTIAL_CHUNK = 1;
/** 1リクエスト当たり PDP(実HTTP) 上限 — 在庫確定 11 件分が上限 */
const MAX_PDP_INSPECTIONS = STOCK_CHUNK_SEEK;
const MAX_PDP_SEQUENTIAL = 1;
const PDP_PER_RESPONSE = STOCK_DISPLAY;

function setNoStore(res) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function jtrunc(s, n = 220) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * クライアント：debug に依存しないスナップショット。大人・子（forChild 切替用）の両方。
 * forChild 時は getUserShoeCmRawForPostFilter が子の cm だけを参照することと整合させる。
 */
function userSettingsForResponse(settings) {
  if (!settings || typeof settings !== 'object') {
    return {
      shoeCm: null,
      clothing: null,
      prefecture: null,
      childGender: null,
      childClothSize: null,
      childShoeSize: null,
    };
  }
  const shoeCm =
    typeof settings.shoeCm === 'number' && Number.isFinite(settings.shoeCm)
      ? settings.shoeCm
      : null;
  const clothing = settings.clothing != null && settings.clothing !== '' ? String(settings.clothing) : null;
  const prefecture = settings.prefecture != null && settings.prefecture !== '' ? String(settings.prefecture) : null;
  const childGender =
    settings.childGender === 'boy' || settings.childGender === 'girl' ? settings.childGender : null;
  const childClothSize =
    settings.childClothSize != null && settings.childClothSize !== '' ? String(settings.childClothSize) : null;
  const childShoeSize =
    settings.childShoeSize != null && settings.childShoeSize !== '' ? String(settings.childShoeSize) : null;
  return { shoeCm, clothing, prefecture, childGender, childClothSize, childShoeSize };
}

function itemHaystackHasModel(item, modelNumbers) {
  const t = buildSerpPlainTextHaystack(item).toUpperCase();
  return modelNumbers.some((m) => t.includes(String(m).toUpperCase()));
}

/**
 * 除外・中古などの生一覧を作る
 */
function buildCleanItemsFromRaw(allItems) {
  const seen = new Set();
  return allItems.filter((item) => {
    const key = `${item.sourceId}:${item.itemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const title = String(item.title || '').toLowerCase();
    return !['中古', 'used', '古着', 'ヤフオク'].some((w) => title.includes(w));
  });
}

/**
 * ①〜④ フィルタ（在庫検索専用プール）
 */
function applyMallItemFilters(
  cleanItems,
  baseKeyword,
  requiredModels,
  isCloth,
  settings,
  forChild
) {
  let pool = cleanItems;
  if (requiredModels.length > 0) {
    pool = pool.filter((item) => itemHaystackHasModel(item, requiredModels));
  }
  pool = pool.filter((item) => validateColorMatchForItem(item, baseKeyword));

  if (isCloth && settings) {
    const cloth = forChild && settings.childClothSize
      ? String(settings.childClothSize).trim()
      : (settings.clothSize || settings.clothing || '');
    if (cloth) {
      const si = { type: 'clothing', raw: cloth.toUpperCase() };
      pool = pool.filter((item) => hasSizeInTitleUniversal(buildSerpPlainTextHaystack(item), si));
    }
  }

  if (requiredModels.length === 0) {
    const nameOnly = stripModelCodesAndSizeForNameQuery(baseKeyword);
    const norm = normalizeBrand(nameOnly);
    pool = pool.filter((item) => matchesProductKeyword(item, nameOnly, norm));
  }
  return pool;
}

function toPerKwLog(shopResults, kwList) {
  return kwList.map((kw, i) => {
    const r = shopResults[i];
    if (r && r.status === 'fulfilled') {
      const v = r.value || {};
      return { kw: jtrunc(kw, 120), items: (v.items || []).length, errors: v.errors || [] };
    }
    return { kw: jtrunc(kw, 120), error: (r && r.reason && (r.reason.message || String(r.reason))) || '?' };
  });
}

/**
 * 靴 PDP — 1リクエスト＝1区切り: モール 3 ページまで、在庫確定は 11 件（10 表示＋1 バトン）、PDP 呼び出し 11 回上限
 */
async function runPdpShoeWithMallPaging({
  kwList,
  baseKeyword,
  requiredModels,
  isCloth,
  settings,
  forChild,
  shoeSizeRaw,
  prePdpScanIn,
  excludeKeysArr,
  excludeSellerModelKeysArr,
  sequentialPdp = false,
}) {
  const displayCap = sequentialPdp ? STOCK_SEQUENTIAL_DISPLAY : STOCK_DISPLAY;
  const chunkSeek = sequentialPdp ? STOCK_SEQUENTIAL_CHUNK : STOCK_CHUNK_SEEK;
  const maxPdp = sequentialPdp ? MAX_PDP_SEQUENTIAL : MAX_PDP_INSPECTIONS;
  const excludeKeys = new Set((excludeKeysArr || []).map(String).filter(Boolean));
  const excludeSellerModelKeys = new Set((excludeSellerModelKeysArr || []).map(String).filter(Boolean));
  const scan = Math.max(0, Math.floor(Number(prePdpScanIn) || 0));
  /** 運び屋: 順次 1 件出しのとき 1 リクエストあたりのモール「めくり」本数を絞る */
  const maxMallThisRequest = sequentialPdp ? MAX_MALL_PAGE_SEQUENTIAL : MAX_MALL_PAGE_PER_STAGED_REQUEST;

  const seenMall = new Set();
  const allRaw = [];
  let mallP = 1;
  let lastShopResults = null;
  let lastPerKw = [];
  let lastPool = [];
  let exhaustedMall = false;
  let lastPageHadItems = false;

  for (;;) {
    const pool = applyMallItemFilters(
      buildCleanItemsFromRaw([...allRaw]),
      baseKeyword,
      requiredModels,
      isCloth,
      settings,
      forChild
    );
    lastPool = pool;
    if (pool.length > scan) break;
    if (mallP > maxMallThisRequest) {
      exhaustedMall = true;
      break;
    }
    const { allItems, shopResults } = await fetchMallPageSliceForKeywordList(kwList, mallP, HITS_PER_PAGE);
    lastShopResults = shopResults;
    lastPerKw = toPerKwLog(shopResults, kwList);
    mallP++;
    if (!allItems || allItems.length === 0) {
      lastPageHadItems = false;
      exhaustedMall = true;
      break;
    }
    lastPageHadItems = true;
    pushUniqueMallItems(allRaw, allItems, seenMall);
  }

  let stopReason = 'ok_chunk';
  if (exhaustedMall && allRaw.length === 0) {
    return {
      displayItems: [],
      nextStartingItem: null,
      pdpShoeLog: [],
      prePdpScanIndex: 0,
      beforePdp: 0,
      perKw: lastPerKw,
      shopResults: lastShopResults,
      poolLength: 0,
      hasMore: false,
      lastMallPage: Math.max(0, mallP - 1),
      exhaustedMall: true,
      lastPageHadItems: false,
      pdpCalls: 0,
      allVerified: [],
      stopReason: 'no_mall_raw',
    };
  }

  const pool = lastPool;
  if (pool.length <= scan) {
    return {
      displayItems: [],
      nextStartingItem: null,
      pdpShoeLog: [],
      prePdpScanIndex: scan,
      beforePdp: 0,
      perKw: lastPerKw,
      shopResults: lastShopResults,
      poolLength: pool.length,
      hasMore: false,
      lastMallPage: Math.max(0, mallP - 1),
      exhaustedMall,
      lastPageHadItems,
      pdpCalls: 0,
      allVerified: [],
      stopReason: 'pool_short',
    };
  }

  const r = await collectPdpShoeVerifies(pool, shoeSizeRaw, {
    prePdpScanIndex: scan,
    excludeKeys,
    excludeSellerModelKeys,
    targetCount: chunkSeek,
    maxPdpCalls: maxPdp,
  });

  const allVerified = r.items || [];
  const displayItems = allVerified.slice(0, displayCap);
  const nextStartingItem = sequentialPdp ? null : allVerified[STOCK_DISPLAY] || null;
  if (sequentialPdp) {
    if (allVerified.length >= 1) stopReason = r.hitPoolEnd ? 'ok_seq_1' : 'ok_seq_1';
    else stopReason = r.hitPoolEnd ? 'empty_pool_end' : 'empty_pdp';
  } else if (allVerified.length >= STOCK_CHUNK_SEEK) {
    stopReason = 'ok_11_baton';
  } else if (displayItems.length >= 1) {
    stopReason = r.hitPoolEnd ? 'partial_pool_end' : 'partial_pdp_cap';
  } else {
    stopReason = r.hitPoolEnd ? 'empty_pool_end' : 'empty_pdp';
  }

  const poolEnd = pool.length;
  const finalNext = r.nextPrePdpScanIndex;
  const mallCapped = mallP - 1 >= maxMallThisRequest;
  const hasMore = finalNext < poolEnd || (mallCapped && lastPageHadItems);

  return {
    displayItems,
    nextStartingItem,
    pdpShoeLog: r.log || [],
    prePdpScanIndex: finalNext,
    beforePdp: poolEnd,
    perKw: lastPerKw,
    shopResults: lastShopResults,
    poolLength: poolEnd,
    hasMore: !!hasMore,
    lastMallPage: Math.max(0, mallP - 1),
    exhaustedMall,
    lastPageHadItems,
    pdpCalls: r.pdpCalls,
    allVerified,
    stopReason,
    staged: {
      maxMallPagesThisRequest: maxMallThisRequest,
      maxPdpThisRequest: maxPdp,
      seek: chunkSeek,
      sequentialPdp: !!sequentialPdp,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const t0 = Date.now();
  try {
    const body = req.body || {};
    const { keyword, userId, forChild: forChildB } = body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });
    const safeUserId = sanitizeUserId(typeof userId === 'string' ? userId : '');
    if (!safeUserId) {
      return res
        .status(400)
        .json({ error: 'USER_SETTINGS_REQUIRED', msg: 'ログインが必要です' });
    }
    const forChild = !!forChildB;
    const listOffset = Math.max(0, Math.floor(Number(body.offset) || 0));
    const limit = Math.max(1, Math.min(30, Math.floor(Number(body.limit) || 10)));
    const excludeKeys = Array.isArray(body.excludeKeys) ? body.excludeKeys : [];
    const excludeSellerModelKeys = Array.isArray(body.excludeSellerModelKeys)
      ? body.excludeSellerModelKeys
      : [];

    const baseKeyword = String(keyword).trim();
    const settings = await loadUserSettings(safeUserId);
    if (!settings) {
      return res
        .status(400)
        .json({ error: 'SETTINGS_NOT_FOUND', msg: 'ユーザー設定を完了してください' });
    }

    const { isShoe, isCloth } = genresForKeyword(baseKeyword);
    const userCmRaw = getUserShoeCmRawForPostFilter(settings, forChild);
    if (isShoe && !userCmRaw) {
      setNoStore(res);
      return res.status(200).json({
        found: false,
        items: [],
        msg: '靴のサイズを設定すると在庫が確認できます',
        userSettings: userSettingsForResponse(settings),
        normalizedKeyword: normalizeBrand(stripSizeCmFromDisplayKeyword(baseKeyword)),
        inventoryRuleNoHits: true,
        inventorySizeVerifyAtPdp: true,
        searchCursor: { prePdpScanIndex: 0, hasMore: false, listOffset: 0, limit },
        debug: { note: 'shoe_size_required', baseKeyword: stripSizeCmFromDisplayKeyword(baseKeyword) },
      });
    }

    const { kwList, strategy, modelNumbers: modelsFromMallBuilder } = buildMallSearchKeywordList(baseKeyword);
    const requiredModels = extractModelNumbers(baseKeyword);
    const shoeSizeRaw = userCmRaw;
    const pdpShoeMode = !!(userCmRaw && isShoe);

    // 靴PDP: prePdpScanIndex 優先。次へ API は offset も同じカーソルとして使う
    const prePdpScanIn = pdpShoeMode
      ? Math.max(0, Math.floor(Number(body.prePdpScanIndex ?? body.offset) || 0))
      : 0;

    console.log(
      '[AUDIT][search] mallQuery',
      JSON.stringify({
        baseKeyword: jtrunc(baseKeyword),
        strategy,
        kwList,
        requiredModels,
        pdpShoeMode,
        prePdpScanIn,
        listOffset,
        hasUser: true,
      })
    );

    if (kwList.length === 0) {
      setNoStore(res);
      return res.status(200).json({
        found: false,
        items: [],
        userSettings: userSettingsForResponse(settings),
        normalizedKeyword: normalizeBrand(stripSizeCmFromDisplayKeyword(baseKeyword)),
        inventoryRuleNoHits: true,
        inventorySizeVerifyAtPdp: true,
        searchCursor: { prePdpScanIndex: 0, hasMore: false, listOffset: 0, limit },
        debug: { note: 'mallQuery_empty', baseKeyword: stripSizeCmFromDisplayKeyword(baseKeyword) },
      });
    }

    const sequentialPdp = !!body.sequentialPdp;

    if (pdpShoeMode) {
      const r = await runPdpShoeWithMallPaging({
        kwList,
        baseKeyword,
        requiredModels,
        isCloth,
        settings,
        forChild,
        shoeSizeRaw,
        prePdpScanIn,
        excludeKeysArr: excludeKeys,
        excludeSellerModelKeysArr: excludeSellerModelKeys,
        sequentialPdp,
      });

      const displayTrim = stripSizeCmFromDisplayKeyword(baseKeyword);
      const t1 = Date.now();
      const mapItem = (it) => ({
        ...it,
        itemKey: it.itemKey || itemCanonicalKey(it),
        dedupeSellerModel: it.dedupeSellerModel || sellerModelDedupeKey(it),
      });
      const itemsOut = (r.displayItems || []).map(mapItem);
      const nextStartingItem = r.nextStartingItem ? mapItem(r.nextStartingItem) : null;
      const inventorySizeVerifyAtPdp = itemsOut.length === 0;

      setNoStore(res);
      const us = userSettingsForResponse(settings);
      return res.status(200).json({
        found: itemsOut.length > 0,
        items: itemsOut,
        nextStartingItem,
        userSettings: us,
        /** 運び屋メタ: debug 以外でも都道府県等を追える（将来送料 API 用に prefecture 同梱） */
        searchMeta: {
          pdpShoe: true,
          carrier: sequentialPdp ? 'sequential-one-pdp' : 'batched-11',
          userSettings: us,
          mallPageBudget: r.staged && r.staged.maxMallPagesThisRequest,
          maxPdpBudget: r.staged && r.staged.maxPdpThisRequest,
          pdpCallsActual: r.pdpCalls,
        },
        normalizedKeyword: normalizeBrand(displayTrim),
        inventoryRuleNoHits: (r.poolLength || 0) > 0 && itemsOut.length === 0,
        inventorySizeVerifyAtPdp,
        limit: sequentialPdp ? 1 : PDP_PER_RESPONSE,
        searchCursor: {
          prePdpScanIndex: r.prePdpScanIndex,
          hasMore: r.hasMore,
          poolLength: r.poolLength,
          lastMallPage: r.lastMallPage,
          exhaustedMall: r.exhaustedMall,
          staged: r.staged,
          pdpCallsThisRequest: r.pdpCalls,
          sequentialPdp: !!sequentialPdp,
        },
        debug: {
          strategy,
          noSizeInMallQuery: true,
          baseKeyword: displayTrim,
          keywordsSentToMall: kwList,
          pdpShoeLog: r.pdpShoeLog,
          stopReason: r.stopReason,
          profileFromRedis: {
            shoeCm: settings.shoeCm != null ? settings.shoeCm : null,
            clothing: settings.clothing != null ? settings.clothing : null,
            prefecture: settings.prefecture != null ? settings.prefecture : null,
          },
          counts: {
            poolLength: r.poolLength,
            pdpShoe: {
              before: r.beforePdp,
              display: itemsOut.length,
              baton: nextStartingItem ? 1 : 0,
              pdpCalls: r.pdpCalls,
            },
          },
          audit: {
            totalMs: t1 - t0,
            shopMs: 0,
            strategy,
            mallKwList: kwList.map((k) => jtrunc(k, 200)),
            modelsFromMallBuilder,
            requiredModels,
            perKwShop: r.perKw,
            shopErrors: (r.perKw || []).flatMap((p) => p.errors || []),
            shoeSizeRaw,
            pdpShoe: { mode: true, prePdpScan: r.prePdpScanIndex, stopReason: r.stopReason, sequentialPdp: !!sequentialPdp },
          },
        },
      });
    }

    // ── 服・靴以外: オフセット + limit（PDP なし）＋ モール拡張
    const seenMall = new Set();
    const allRaw = [];
    let mallP = 1;
    let perKw = [];
    const targetEnd = listOffset + limit;
    while (mallP <= MAX_MALL_PAGE) {
      const pool0 = applyMallItemFilters(
        buildCleanItemsFromRaw([...allRaw]),
        baseKeyword,
        requiredModels,
        isCloth,
        settings,
        forChild
      );
      if (pool0.length >= targetEnd) break;
      const { allItems, shopResults } = await fetchMallPageSliceForKeywordList(kwList, mallP, HITS_PER_PAGE);
      perKw = toPerKwLog(shopResults, kwList);
      mallP++;
      if (!allItems || allItems.length === 0) {
        break;
      }
      pushUniqueMallItems(allRaw, allItems, seenMall);
    }
    if (allRaw.length === 0) {
      const displayTrim0 = stripSizeCmFromDisplayKeyword(baseKeyword);
      setNoStore(res);
      return res.status(200).json({
        found: false,
        items: [],
        userSettings: userSettingsForResponse(settings),
        normalizedKeyword: normalizeBrand(displayTrim0),
        inventoryRuleNoHits: true,
        inventorySizeVerifyAtPdp: true,
        searchCursor: { hasMore: false, listOffset, limit },
        debug: { note: 'no_mall_items', baseKeyword: displayTrim0 },
      });
    }

    const cleanItems = buildCleanItemsFromRaw(allRaw);
    let pool = applyMallItemFilters(
      cleanItems,
      baseKeyword,
      requiredModels,
      isCloth,
      settings,
      forChild
    );
    const poolLength = pool.length;
    const slice = pool.slice(listOffset, listOffset + limit).map((it) => {
      const k = itemCanonicalKey(it);
      return {
        ...it,
        itemKey: k,
        dedupeSellerModel: sellerModelDedupeKey(it),
      };
    });
    const hasMoreList = listOffset + slice.length < poolLength;
    const t1 = Date.now();
    const displayTrim = stripSizeCmFromDisplayKeyword(baseKeyword);
    setNoStore(res);
    return res.status(200).json({
      found: slice.length > 0,
      items: slice,
      userSettings: userSettingsForResponse(settings),
      normalizedKeyword: normalizeBrand(displayTrim),
      inventoryRuleNoHits: cleanItems.length > 0 && pool.length === 0,
      inventorySizeVerifyAtPdp: true,
      limit,
      searchCursor: {
        listOffset: listOffset + slice.length,
        hasMore: hasMoreList,
        poolLength,
      },
      debug: {
        strategy,
        noSizeInMallQuery: true,
        baseKeyword: displayTrim,
        keywordsSentToMall: kwList,
        profileFromRedis: {
          shoeCm: settings.shoeCm != null ? settings.shoeCm : null,
          clothing: settings.clothing != null ? settings.clothing : null,
          prefecture: settings.prefecture != null ? settings.prefecture : null,
        },
        audit: {
          totalMs: t1 - t0,
          strategy,
          perKwShop: perKw,
          shopErrors: (perKw || []).flatMap((p) => p.errors || []),
        },
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
