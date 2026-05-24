/**
 * POST /api/search — **唯一の実装ソース**（Vercel 本番は `api/search.js` がこのモジュールを呼び出す）。
 * 在庫検索 — 方針:
 *  - 楽天・Yahoo へのクエリに cm / プロファイル由来のサイズを混ぜない
 *  - 品番が取れたら API は品番のみ。なければメーカー＋商品名（cm 抜き）
 *  - 靴＋マイ cm: プールを素点＋最終点で再ソート（候補は捨てない）→ 上位Nだけ verifyShoeSizeOnPdp 並列 → 全件再ソート
 *  - ページング: prePdpScanIndex / offset / excludeKeys / excludeSellerModelKeys / nextStartingItem(バトン)
 *
 * フロントは sequentialPdp + **limit:1** を連続（初回6枠・次へ・先読み）で呼び、PDP(HTTP) を serverless 時間内に収める。
 * 厳密に「商品 PDP の HTML 解析を利用者端末へ」置くことは、楽天/Yahoo 等の **CORS 制約**でブラウザ直 fetch が通らないため、**PDP 取得は自サーバ経由が前提**。サーバは重い一括ループを避け、1 区切り・短タイムアウトで 10s 壁を下回る設計を意識する。
 */

import { loadUserSettings, getUserShoeCmRawForPostFilter, genresForKeyword } from '../lib/user-size.js';
import { sanitizeUserId } from '../lib/user-settings.js';
import { getRedis } from '../lib/redis.js';
import {
  buildMallSearchKeywordList,
  stripSizeCmFromDisplayKeyword,
  stripModelCodesAndSizeForNameQuery,
  normalizeBrand,
} from '../lib/stock-search-query.js';
import { extractModelNumbers, hasSizeInTitleUniversal } from '../lib/cross-validator.js';
import { buildSerpPlainTextHaystack, validateColorMatchForItem } from '../lib/color-filter.js';
import { matchesProductKeyword } from '../lib/keyword-match.js';
import { verifyShoeSizeOnPdp } from '../lib/pdp-shoe-stock.js';
import { itemCanonicalKey, sellerModelDedupeKey } from '../lib/stock-dedupe.js';
import { fetchMallPageSliceForKeywordList, pushUniqueMallItems } from '../lib/search-mall-fetch.js';
import { userPlanKey } from '../lib/monitor-constants.js';
import { getCircuit } from '../lib/re-eye-circuit.js';

async function getCircuitStateSafe() {
  try {
    const r = getRedis();
    return await getCircuit(r);
  } catch {
    return 'unknown';
  }
}

const HITS_PER_PAGE = 20;
/** 一覧のみ（非PDP）: 1リクエストあたり取得するモールページ上限 */
const MAX_MALL_PAGE = 5;
/** 靴PDP: 1 API 当たりにめくるモールページ数（遅延抑制のため控えめ） */
const MAX_MALL_PAGE_PER_STAGED_REQUEST = 2;
/**
 * 順次 PDP: 1 回の serverless 内のモールめくり（1 にすると初回 TTFB を短くしやすい）
 */
const MAX_MALL_PAGE_SEQUENTIAL = 1;
/** 1リクエストで在庫確定を狙う件数: 7 表示 + 1 次バトン（PDP 回数抑制） */
const STOCK_DISPLAY = 7;
const STOCK_SEEK_PEEK = 1;
const STOCK_CHUNK_SEEK = STOCK_DISPLAY + STOCK_SEEK_PEEK; // 8
/** 順次モード: 1リクエストあたりの上限（PDP 回数＝この値まで。Vercel 時間との折衷で最大5） */
const STOCK_SEQUENTIAL_CAP_DEFAULT = 2;
const STOCK_SEQUENTIAL_CAP_MAX = 3;
/** 1リクエスト当たり PDP(実HTTP) 上限（= chunkSeek に同期） */
const MAX_PDP_INSPECTIONS = STOCK_CHUNK_SEEK;
const PDP_PER_RESPONSE = STOCK_DISPLAY;
/** 並列度（同一時刻に飛ばす最大 fetch 本数） */
const SHOE_PDP_CONCURRENCY = 3;
/** STANDARD: 上位3 PDP / PRO・VIP: 上位6 PDP */
function getShoePdpBudgetForPlan(plan) {
  const p = String(plan || 'FREE').toUpperCase();
  if (p === 'FREE') return 0;
  if (p === 'STANDARD') return 3;
  if (p === 'PRO' || p === 'VIP') return 6;
  return 3;
}

const PLAN_ALLOWED = new Set(['FREE', 'STANDARD', 'PRO', 'VIP']);
function normalizePlan(p) {
  const v = String(p || '').trim().toUpperCase();
  return PLAN_ALLOWED.has(v) ? v : null;
}
/** ① サイズモード: cm はキーワード内の「数値＋cm/㎝」明示のみ（年号の2桁単体は見ない） */
function detectSizeMode({ category, keyword }) {
  const k = String(keyword || '');

  if (/\d{2}(?:\.\d)?\s*(cm|㎝)/.test(k)) return 'cm';

  if (category === 'shoes') return 'cm';

  return 'alpha';
}

/** ② 共通 haystack（`buildSerpPlainTextHaystack` 優先） */
function buildFullHaystack(raw) {
  return (
    buildSerpPlainTextHaystack(raw || {}) ||
    [
      raw?.title,
      raw?.description,
      raw?.catchcopy,
      raw?.itemCaption,
      raw?.headLine,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

/** ③ 不正サイズ遮断（入口）— `!hay` は不正 */
function isInvalidSizeExpression(hay) {
  if (!hay) return true;

  if (/\d{2}(?:\.\d)?\s*[-～〜]\s*\d{2}\s*(cm|㎝)/.test(hay)) return true;

  if (/約\s*\d{2}(?:\.\d)?\s*(cm|㎝)/.test(hay)) return true;
  if (/前後\s*\d{2}(?:\.\d)?\s*(cm|㎝)/.test(hay)) return true;

  return false;
}

/** ⑩ cm ターゲット（推測禁止）— multiTargetCm + キーワード内の明示 `\d+cm` のみ */
function resolveShoeCmTargetsStrict(settings, opts = {}) {
  const out = [];
  const seen = new Set();

  const isChild = opts.forChild === true || settings?.forChild === true;

  const MIN = isChild ? 10 : 14;
  const MAX = isChild ? 25 : 35;

  const add = (v) => {
    const n = normalizeCm(v);
    if (n === null) return;
    if (n < MIN || n > MAX) return;

    const key = String(n);
    if (seen.has(key)) return;

    seen.add(key);
    out.push(n);
  };

  (opts.multiTargetCm || []).forEach(add);

  const kw = String(opts.keyword != null ? opts.keyword : opts.rawKeyword || '');
  const match = kw.match(/(\d{2}(?:\.\d)?)\s*(cm|㎝)/);
  if (match) add(match[1]);

  return out;
}

/** ① SERP 投入前（靴）— hay が無ければ通過、あれば不正表記を遮断 */
function preSerpFilter(raw) {
  const hay = buildFullHaystack(raw || {});
  if (!hay) return true;
  return !isInvalidSizeExpression(hay);
}

async function resolveUserPlan(r, userId, requestPlan) {
  const rp = normalizePlan(requestPlan);
  if (rp) return rp;
  try {
    const raw = await r.get(userPlanKey(userId));
    return normalizePlan(raw) || 'FREE';
  } catch {
    return 'FREE';
  }
}
/** P0: サイズヒント・±ギャップ加点なし（並びは在庫系ヒント／Yahoo／未開封のみ） */
function baseShoeMallRowScore(item) {
  const h = buildSerpPlainTextHaystack(item) || (item && item.title) || '';
  const hasStockHint = /在庫|購入|カート|かご|stock|cart/iu.test(h);
  const isYahoo = /yahoo/iu.test(String((item && item.url) || ''));
  let s = 0;
  if (hasStockHint) s += 20;
  if (isYahoo) s += 10;
  s += newUnopenedPriorityScore(item);
  return { baseScore: s, hasStockHint, isYahoo };
}
/** enrich + baseScore 降順。候補は消さない。 */
function enrichAndSortShoePool(pool) {
  if (!Array.isArray(pool) || pool.length < 2) {
    if (!Array.isArray(pool) || pool.length === 0) return pool;
    const one = pool[0];
    return [{ ...one, ...baseShoeMallRowScore(one) }];
  }
  return [...pool]
    .map((it) => ({ ...it, ...baseShoeMallRowScore(it) }))
    .sort((a, b) => {
      const d = (b.baseScore || 0) - (a.baseScore || 0);
      if (d !== 0) return d;
      return newUnopenedPriorityScore(b) - newUnopenedPriorityScore(a);
    });
}
/**
 * PDP 成否は既存 verifyShoeSizeOnPdp。帯: 確定 ＞ 仮 ＞ 未PDP ＞ 否定（数値に ok を入れない未PDP は +10 のみ上乗せ）
 * @param {object} item merge 後（pdpMerged / ok / pdpTentative がありうる）
 */
function finalShoeMallRowScore(item) {
  const base = item.baseScore || 0;
  if (item.pdpMerged) {
    if (item.ok === true && !item.pdpTentative) return base + 120;
    if (item.ok === true && item.pdpTentative) return base + 40;
    if (item.ok === false) return base - 80;
  }
  return base + 10;
}
/**
 * 上位 N 行だけ再帰的に走査。exclude / sellerModel は従来どおり 1 行ずつ前進しながら詰める。
 * @param {{ item: object, poolIndex: number }[]} batch
 * @param {string} rawCm
 * @param {number} [limit]
 */
async function runShoePdpBatchedInChunks(batch, rawCmTargets, limit = SHOE_PDP_CONCURRENCY) {
  const out = [];
  for (let i = 0; i < batch.length; i += limit) {
    const chunk = batch.slice(i, i + limit);
    const part = await Promise.all(
      chunk.map(async (b) => {
        try {
          const v = await verifyShoeSizeOnPdp(
            b.item,
            Array.isArray(rawCmTargets) && rawCmTargets.length
              ? rawCmTargets.map((n) => String(n))
              : rawCmTargets
          );
          return { key: itemCanonicalKey(b.item), item: b.item, v };
        } catch (e) {
          return {
            key: itemCanonicalKey(b.item),
            item: b.item,
            v: { ok: false, pdpTentative: false, reason: 'verify_throw', method: 'none' },
          };
        }
      })
    );
    out.push(...part);
  }
  return out;
}
/**
 * プール上に PDP 結果を写す。filter なし。キー衝突で二重上書きしない（先勝ち）
 * @param {object[]} poolEnriched
 * @param {Array<{ key: string, item: object, v: object }>} pdpPairs
 */
function mergeShoePdpIntoPool(poolEnriched, pdpPairs) {
  const m = new Map();
  for (const p of pdpPairs) {
    if (p && p.key && !m.has(p.key)) m.set(p.key, p.v);
  }
  return poolEnriched.map((it) => {
    const k = itemCanonicalKey(it);
    const v = m.get(k);
    if (!v) return it;
    return { ...it, ...v, pdpMerged: true, itemKey: it.itemKey || k };
  });
}
/**
 * 未PDP 行に ok=true を乗せない（候補は pdpSizeCheck.ok === null）
 * @param {object} it merge 直後
 */
function mapShoeSearchItemForClient(it) {
  const neg = it.pdpMerged && it.ok === false;
  const {
    ok: _rawOk,
    reason,
    method,
    ms,
    pdpTentative,
    pdpMerged: _m,
    hasStockHint: _hs,
    isYahoo: _iy,
    baseScore: _bs,
    ...rest0
  } = it;
  const rest = { ...rest0 };
  if ('finalScore' in rest) delete rest.finalScore;
  if ('pdpMerged' in rest) delete rest.pdpMerged;
  const strictConfirmed = it.ok === true && !it.pdpTentative;
  /** @type {true | false | null} */
  const pdcOk = it.pdpMerged
    ? strictConfirmed
      ? true
      : it.ok === false
        ? false
        : null
    : null;
  return {
    ...rest,
    itemKey: rest.itemKey || itemCanonicalKey(it),
    dedupeSellerModel: rest.dedupeSellerModel || sellerModelDedupeKey(it),
    pdpSizeVerified: it.pdpMerged && strictConfirmed,
    pdpSizeTentative: false,
    available: it.ok !== false,
    pdpSizeCheck: it.pdpMerged
      ? {
          ok: pdcOk,
          reason,
          method,
          ms,
          tentative: false,
          scanned: true,
          strictConfirmed,
        }
      : {
          ok: null,
          reason: 'pdp_not_scanned_in_batch',
          tentative: true,
          scanned: false,
        },
  };
}

/** ⑤ cm 正規化 */
function normalizeCm(v) {
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** ⑪ アルファ正規化 */
function normalizeAlphaSize(v) {
  if (!v) return null;

  const s = String(v).toUpperCase().trim();

  if (['XS', 'S', 'M', 'L', 'XL', 'XXL'].includes(s)) return s;

  return null;
}

/** ⑫ ターゲット取得（`clothSize` + キーワード内アルファのみ） */
function resolveAlphaTargets(settings, opts = {}) {
  const out = new Set();

  const add = (v) => {
    const n = normalizeAlphaSize(v);
    if (n) out.add(n);
  };

  add(settings?.clothing);
  add(settings?.clothSize);

  const kw = String(opts.keyword || '');

  const match = kw.match(/(?:^|[\s　])(XXL|XL|L|M|S|XS)(?=[\s　]|$|サイズ)/i);

  if (match) add(String(match[1]).toUpperCase());

  return [...out];
}

/** ⑬ SERP からアルファサイズ抽出 */
function extractAlphaSizes(hay) {
  if (!hay) return [];

  const matches = [...hay.matchAll(/(?:^|[\s　])(XXL|XL|L|M|S|XS)(?=[\s　]|$|サイズ)/gi)];

  return matches.map((m) => String(m[1]).toUpperCase());
}

/** ⑭ 一致判定 */
function computeAlphaMatch(hay, targets) {
  const extracted = extractAlphaSizes(hay);

  if (!targets?.length || !extracted.length) return false;

  return targets.some((t) => extracted.includes(t));
}

function mapItemForClient(it) {
  const k = itemCanonicalKey(it);
  const rest = { ...it };
  if ('finalScore' in rest) delete rest.finalScore;
  return {
    ...rest,
    itemKey: rest.itemKey || k,
    dedupeSellerModel: rest.dedupeSellerModel || sellerModelDedupeKey(it),
  };
}

/** ⑮ 服ゲート（未記載排除）。ターゲット未指定時は「SERP にアルファ表記がある行」だけ通す */
function mapClothItemWithSizeGate(rawIt, targets) {
  if (!targets?.length) {
    const hay0 = buildFullHaystack(rawIt);
    const extracted0 = extractAlphaSizes(hay0);

    if (!extracted0.length) return null;

    return mapItemForClient(rawIt);
  }

  const mapped = mapItemForClient(rawIt);

  const hay = buildFullHaystack(rawIt);

  const extracted = extractAlphaSizes(hay);

  if (!extracted.length) return null;

  const match = computeAlphaMatch(hay, targets);

  if (!match) return null;

  return {
    ...mapped,
    size_match: true,
  };
}

/** ⑦ PDP 確定チェック */
function isPdpSizeConfirmed(mapped) {
  return (
    mapped?.pdpSizeCheck?.ok === true &&
    mapped?.pdpSizeCheck?.scanned === true &&
    mapped?.pdpSizeCheck?.tentative === false
  );
}

/** ④ cm 抽出（単一トークンのみ） */
function serpExtractApprovedCms(hay) {
  if (!hay) return [];

  if (isInvalidSizeExpression(hay)) return [];

  const matches = [...String(hay).matchAll(/(?<!\d)(\d{2}(?:\.\d)?)(?!\d)\s*(cm|㎝)/g)];

  return matches
    .map((m) => Number(m[1]))
    .filter(Number.isFinite);
}

/** ⑥ 完全一致 */
function computeExactCmMatch(hay, targets) {
  const extracted = serpExtractApprovedCms(hay);

  if (!targets?.length || !extracted.length) return false;

  return targets.some((t) => {
    const nt = normalizeCm(t);
    if (nt === null) return false;

    return extracted.some((e) => {
      const ne = normalizeCm(e);
      return ne !== null && nt === ne;
    });
  });
}

/** ⑧ 靴ゲート */
function mapShoeSearchItemWithSizeGate(rawIt, targets) {
  const mapped = mapShoeSearchItemForClient(rawIt);

  const hay = buildFullHaystack(rawIt);

  if (isInvalidSizeExpression(hay)) return null;

  const exact = computeExactCmMatch(hay, targets);
  const pdp = isPdpSizeConfirmed(mapped);

  if (!(exact && pdp)) return null;

  return {
    ...mapped,
    size_match: true,
  };
}

/** ⑨ 靴: 最終フィルター — cm ターゲット空なら無理に出さず空配列（意図を明確化） */
function buildGatedShoeSortedList(items, targets) {
  if (!Array.isArray(targets) || !targets.length) return [];

  return (items || [])
    .map((it) => mapShoeSearchItemWithSizeGate(it, targets))
    .filter(Boolean);
}

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
 * 新品・未開封系を SERP 段階で優先（タイトル・説明のハイストック）
 * 数値が大きいほど先に PDP / 一覧スライスに来る
 */
function newUnopenedPriorityScore(item) {
  const t = buildSerpPlainTextHaystack(item).toLowerCase();
  let s = 0;
  if (/未開封/.test(t)) s += 5;
  if (/新品|未使用/.test(t)) s += 4;
  if (/正規品|国内正規|メーカー品/.test(t)) s += 2;
  if (/箱付|付属品|タグ付/.test(t)) s += 1;
  return s;
}

/** @param {object[]} pool */
function sortPoolByNewUnopenedFirst(pool) {
  if (!Array.isArray(pool) || pool.length < 2) return pool;
  return [...pool].sort((a, b) => {
    const d = newUnopenedPriorityScore(b) - newUnopenedPriorityScore(a);
    if (d !== 0) return d;
    return 0;
  });
}

/**
 * ── stockFilterLayer ─────────────────────────────────────────────────────────
 *
 * Stage 1: 商品レベル在庫チェック（available + price + テキスト）
 * Stage 2: 購入可能性チェック（URL有効性 + タイトル + 将来 variants 対応）
 * Stage 3: URL基準クロスソース重複排除（楽天・Yahoo 同一商品の 2重返し防止）
 *
 * ★ 設計上の注意 ★
 * 楽天・Yahoo は商品1行=1SKU で返す（variants フィールドはない）。
 * isActuallyPurchasable の variants ブロックは将来拡張用（現時点は到達しない）。
 */

// Stage 1: 商品レベル在庫
function isItemInStock(item) {
  if (!item) return false;
  // available が明示的 false → 確実に除外
  if (item.available === false) return false;
  // price が数値でない、または 0 以下 → 実質非在庫
  if (typeof item.price !== 'number' || item.price <= 0) return false;
  // タイトル・キャプション・説明文に品切れ表現 → 除外
  const hay =
    String(item.title       || '') + ' ' +
    String(item.catchcopy   || '') + ' ' +
    String(item.itemCaption || '') + ' ' +
    String(item.description || '');
  if (/sold.?out|完売|在庫なし|品切れ|欠品|取り扱いなし|out of stock/i.test(hay)) return false;
  return true;
}

// Stage 2: 購入可能性チェック
function isActuallyPurchasable(item) {
  if (!item) return false;

  // 購入ページ URL が存在しない → 購入ボタンを押せない
  if (!item.url || typeof item.url !== 'string' || !item.url.startsWith('http')) return false;

  // タイトルが空または1文字以下 → 商品として成立しない
  if (!item.title || String(item.title).trim().length < 2) return false;

  // variants がある場合（将来拡張: PDP から SKU 一覧を取得した場合）
  // → 1つでも購入可能な SKU があれば通す
  if (Array.isArray(item.variants) && item.variants.length > 0) {
    return item.variants.some(
      (v) =>
        v.available === true &&
        typeof v.price === 'number' &&
        v.price > 0 &&
        !/sold.?out|在庫なし|欠品/i.test(v.label || '')
    );
  }

  return true;
}

// Stage 3: URL基準重複排除（sourceId:itemId 重複排除は buildCleanItemsFromRaw 済み）
// ここでは URL 一致によるクロスソース（楽天・Yahoo 同一商品）を除去する
function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    // URL 正規化: クエリ文字列を除いたパスで比較
    let key = item.url || '';
    try {
      const u = new URL(key);
      key = u.origin + u.pathname; // クエリ・ハッシュ除去
    } catch {
      key = item.url || `${item.sourceId}:${item.itemId}`;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortByPriceAsc(items) {
  if (!Array.isArray(items) || items.length < 2) return items;
  return [...items].sort((a, b) => {
    const pa = Number(a?.price) || 0;
    const pb = Number(b?.price) || 0;
    const d = pa - pb;
    if (d !== 0) return d;
    return 0;
  });
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
    return true;
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
  const summary = {
    marketRaw: Array.isArray(cleanItems) ? cleanItems.length : 0,
    noiseExcluded: 0,
    modelMismatch: 0,
    colorMismatch: 0,
    clothSizeMismatch: 0,
    keywordMismatch: 0,
    pdpRejected: 0,
  };
  if (requiredModels.length > 0) {
    const before = pool.length;
    pool = pool.filter((item) => itemHaystackHasModel(item, requiredModels));
    summary.modelMismatch += Math.max(0, before - pool.length);
  }
  {
    const before = pool.length;
  pool = pool.filter((item) => validateColorMatchForItem(item, baseKeyword));
    summary.colorMismatch += Math.max(0, before - pool.length);
  }

  if (isCloth && settings) {
    const cloth = forChild && settings.childClothSize
      ? String(settings.childClothSize).trim()
      : (settings.clothSize || settings.clothing || '');
    if (cloth) {
      const si = { type: 'clothing', raw: cloth.toUpperCase() };
      const before = pool.length;
      pool = pool.filter((item) => hasSizeInTitleUniversal(buildSerpPlainTextHaystack(item), si));
      summary.clothSizeMismatch += Math.max(0, before - pool.length);
    }
  }

  if (requiredModels.length === 0) {
    const nameOnly = stripModelCodesAndSizeForNameQuery(baseKeyword);
    const norm = normalizeBrand(nameOnly);
    const before = pool.length;
    pool = pool.filter((item) => matchesProductKeyword(item, nameOnly, norm));
    summary.keywordMismatch += Math.max(0, before - pool.length);
  }
  return { pool, rejectReasonSummary: summary };
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
 * 靴 PDP — バッチ時は max(STOCK_CHUNK_SEEK) 在庫確定 / 順次は sequentialCap まで
 */
async function runPdpShoeWithMallPaging({
  kwList,
  baseKeyword,
  requiredModels,
  isCloth,
  settings,
  forChild,
  shoeSizeRaw,
  shoeTargetNums = [],
  plan = 'STANDARD',
  prePdpScanIn,
  excludeKeysArr,
  excludeSellerModelKeysArr,
  sequentialPdp = false,
  sequentialCap = STOCK_SEQUENTIAL_CAP_DEFAULT,
}) {
  const seqCap = sequentialPdp
    ? Math.min(
        STOCK_SEQUENTIAL_CAP_MAX,
        Math.max(1, Math.floor(Number(sequentialCap) || STOCK_SEQUENTIAL_CAP_DEFAULT))
      )
    : 0;
  const displayCap = sequentialPdp ? seqCap : STOCK_DISPLAY;
  const chunkSeek = sequentialPdp ? seqCap : STOCK_CHUNK_SEEK;
  const maxPdp = sequentialPdp ? seqCap : MAX_PDP_INSPECTIONS;
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
  let lastRejectSummary = null;
  let lastMallMeta = { marketRaw: 0, noiseExcluded: 0 };
  let exhaustedMall = false;
  let lastPageHadItems = false;

  for (;;) {
    const { pool, rejectReasonSummary } = applyMallItemFilters(
      buildCleanItemsFromRaw([...allRaw]),
      baseKeyword,
      requiredModels,
      isCloth,
      settings,
      forChild
    );
    lastPool = pool;
    lastRejectSummary = rejectReasonSummary;
    if (pool.length > scan) break;
    if (mallP > maxMallThisRequest) {
      exhaustedMall = true;
      break;
    }
    const { allItems, shopResults, meta } = await fetchMallPageSliceForKeywordList(kwList, mallP, HITS_PER_PAGE);
    lastShopResults = shopResults;
    lastPerKw = toPerKwLog(shopResults, kwList);
    lastMallMeta = meta || lastMallMeta;
    mallP++;
    if (!allItems || allItems.length === 0) {
      lastPageHadItems = false;
      exhaustedMall = true;
      break;
    }
    lastPageHadItems = true;
    const allItemsFiltered = (allItems || []).filter(preSerpFilter);
    pushUniqueMallItems(allRaw, allItemsFiltered, seenMall);
    try {
      console.log(
        '[RE_EYE_TRACE][search:pdp-mall-page]',
        JSON.stringify({
          mallPageIndex: mallP - 1,
          apiReturnedRowCount: Array.isArray(allItems) ? allItems.length : 0,
          afterDedupeUniqueRows: allRaw.length,
          filteredPoolLenBeforeBreak: pool.length,
          scan,
        })
      );
    } catch (_) {
      /* */
    }
  }

  let stopReason = 'ok_chunk';
  if (exhaustedMall && allRaw.length === 0) {
    try {
      console.log(
        '[RE_EYE_TRACE][search:pdp-exit]',
        JSON.stringify({
          reason: 'no_mall_raw',
          mallDedupUnique: 0,
          perKwSummaries: lastPerKw.map((x) => ({ kw: x.kw, apiItemsHint: x.items, err: x.error })),
        })
      );
    } catch (_) {
      /* */
    }
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
    try {
      console.log(
        '[RE_EYE_TRACE][search:pdp-exit]',
        JSON.stringify({
          reason: 'pool_short',
          mallDedupUnique: allRaw.length,
          filteredPoolLen: pool.length,
          scan,
          perKwSummaries: lastPerKw.map((x) => ({ kw: x.kw, apiItemsHint: x.items })),
        })
      );
    } catch (_) {
      /* */
    }
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
      rejectReasonSummary: {
        ...(lastRejectSummary || {}),
        ...(lastMallMeta || {}),
        pdpRejected: 0,
      },
      stopReason: 'pool_short',
    };
  }

  const poolOrdered = enrichAndSortShoePool(pool);
  const canPdp = plan !== 'FREE';
  const pdpBudget = getShoePdpBudgetForPlan(plan);
  const shoePdpN = canPdp
    ? Math.min(sequentialPdp ? Math.max(1, seqCap) : pdpBudget, maxPdp)
    : 0;
  const smSeen = new Set([...excludeSellerModelKeys].map(String).filter(Boolean));
  const batch = [];
  let idx = scan;
  if (shoePdpN > 0) {
    while (idx < poolOrdered.length && batch.length < shoePdpN) {
      const item = poolOrdered[idx];
      const k0 = itemCanonicalKey(item);
      if (excludeKeys.has(k0)) {
        idx++;
        continue;
      }
      const sm0 = sellerModelDedupeKey(item);
      if (smSeen.has(sm0)) {
        idx++;
        continue;
      }
      smSeen.add(sm0);
      batch.push({ item, poolIndex: idx });
      idx++;
    }
  }
  const nextPrePdpScanIndex = shoePdpN > 0 ? idx : Math.min(poolOrdered.length, scan + displayCap);

  const pdpCmArg =
    shoeTargetNums.length >= 1 ? shoeTargetNums.map((n) => String(n)) : shoeSizeRaw;
  const pdpOut =
    canPdp && batch.length > 0
      ? await runShoePdpBatchedInChunks(batch, pdpCmArg, SHOE_PDP_CONCURRENCY)
      : [];
  const withPdp = mergeShoePdpIntoPool(
    poolOrdered,
    pdpOut.map((p) => ({ key: p.key, v: p.v }))
  );
  const finalOrdered = withPdp
    .map((it) => ({ ...it, finalScore: finalShoeMallRowScore(it) }))
    .sort((a, b) => {
      const d = (b.finalScore || 0) - (a.finalScore || 0);
      if (d !== 0) return d;
      return newUnopenedPriorityScore(b) - newUnopenedPriorityScore(a);
    });
  const gatedAll = buildGatedShoeSortedList(finalOrdered, shoeTargetNums);
  const displayItems = gatedAll.slice(0, displayCap);
  const nextStartingItem = sequentialPdp ? null : gatedAll[displayCap] ?? null;

  const pdpShoeLog = pdpOut.map((p) => ({
    sourceId: p.item && p.item.sourceId,
    itemId: p.item && p.item.itemId,
    ok: p.v && p.v.ok,
    reason: p.v && p.v.reason,
    ms: p.v && p.v.ms,
    tentative: !!(p.v && p.v.pdpTentative),
  }));
  const pdpChecked = pdpShoeLog.length;
  const allVerified = finalOrdered.filter((it) => it.ok === true);
  const pdpRejected = pdpShoeLog.filter((l) => l.ok === false).length;
  const poolEnd = poolOrdered.length;
  const finalNext = nextPrePdpScanIndex;
  const mallCapped = mallP - 1 >= maxMallThisRequest;
  if (sequentialPdp) {
    if (displayItems.length >= 1) {
      stopReason = finalNext >= poolEnd ? 'ok_seq_batch' : 'ok_seq_batch';
    } else {
      stopReason = finalNext >= poolEnd ? 'empty_pool_end' : 'empty_pdp';
    }
  } else if (pdpShoeLog.length >= 1) {
    stopReason = 'ok_ranked_pdp';
  } else {
    stopReason = finalNext >= poolEnd ? 'empty_pool_end' : 'empty_pdp';
  }

  const hasMore = finalNext < poolEnd || (mallCapped && lastPageHadItems);

  try {
    console.log(
      '[RE_EYE_TRACE][search:pdp-done]',
      JSON.stringify({
        reason: stopReason,
        mallDedupUnique: allRaw.length,
        filteredPoolLen: pool.length,
        poolOrderedLen: poolOrdered.length,
        scanStart: scan,
        nextPreScan: finalNext,
        batchPdps: batch.length,
        displayItemsLen: displayItems.length,
        pdpChecks: pdpShoeLog.length,
        plan,
        sequentialPdp: !!sequentialPdp,
      })
    );
  } catch (_) {
    /* */
  }

  return {
    displayItems,
    nextStartingItem,
    pdpShoeLog: pdpShoeLog,
    prePdpScanIndex: finalNext,
    beforePdp: poolEnd,
    perKw: lastPerKw,
    shopResults: lastShopResults,
    poolLength: poolEnd,
    hasMore: !!hasMore,
    lastMallPage: Math.max(0, mallP - 1),
    exhaustedMall,
    lastPageHadItems,
    pdpCalls: pdpChecked,
    allVerified,
    rejectReasonSummary: {
      ...(lastRejectSummary || {}),
      ...(lastMallMeta || {}),
      pdpRejected,
    },
    stopReason,
    staged: {
      maxMallPagesThisRequest: maxMallThisRequest,
      maxPdpThisRequest: maxPdp,
      pdpScannedThisRequest: shoePdpN,
      seek: shoePdpN,
      displayCap,
      sequentialBatch: sequentialPdp ? seqCap : undefined,
      sequentialPdp: !!sequentialPdp,
      plan,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const t0 = Date.now();
  try {
    const circuitState = await getCircuitStateSafe();
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
    try {
      console.log('[RE_EYE][SEARCH]', JSON.stringify({ circuitState, keyword: baseKeyword.slice(0, 120), ts: Date.now() }));
    } catch {
      /* ignore */
    }
    const settings = await loadUserSettings(safeUserId);
    if (!settings) {
      return res
        .status(400)
        .json({ error: 'SETTINGS_NOT_FOUND', msg: 'ユーザー設定を完了してください' });
    }
    const effectivePlan = await resolveUserPlan(getRedis(), safeUserId, body.plan);

    const { isShoe, isCloth, isAccessoryGlove } = genresForKeyword(baseKeyword);

    /** @type {number[]} */
    let shoeTargetNums = resolveShoeCmTargetsStrict(settings, {
      keyword: baseKeyword,
      rawKeyword: baseKeyword,
      forChild,
      multiTargetCm: Array.isArray(body.multiTargetCm) ? body.multiTargetCm : undefined,
    });
    const userCmRaw = getUserShoeCmRawForPostFilter(settings, forChild);
    if (!shoeTargetNums.length && userCmRaw) {
      const q = parseFloat(String(userCmRaw).replace(/cm$/i, '').trim());
      const okRange = forChild ? q >= 10 && q <= 25 : q >= 14 && q <= 35;
      if (Number.isFinite(q) && okRange) shoeTargetNums = [Math.round(q * 10) / 10];
    }

    const shoeSizeRaw = shoeTargetNums.length
      ? shoeTargetNums
          .map((n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.?0+$/, '').replace(/^(\d+)\.$/, '$1')))
          .join(',')
      : userCmRaw || '';

    if (isShoe && shoeTargetNums.length === 0) {
      try {
        console.log('[RE_EYE_TRACE][search:resp]', JSON.stringify({ exit: 'shoe_size_required', itemsLen: 0 }));
      } catch (_) {
        /* */
      }
      setNoStore(res);
      return res.status(200).json({
        found: false,
        items: [],
        msg: '靴のサイズを設定すると在庫が確認できます',
        userSettings: userSettingsForResponse(settings),
        normalizedKeyword: normalizeBrand(stripSizeCmFromDisplayKeyword(baseKeyword)),
        inventoryRuleNoHits: true,
        inventorySizeVerifyAtPdp: true,
        searchMeta: { circuitState },
        searchCursor: { prePdpScanIndex: 0, hasMore: false, listOffset: 0, limit },
        debug: { note: 'shoe_size_required', baseKeyword: stripSizeCmFromDisplayKeyword(baseKeyword) },
      });
    }

    const { kwList, strategy, modelNumbers: modelsFromMallBuilder } = buildMallSearchKeywordList(baseKeyword);
    const requiredModels = extractModelNumbers(baseKeyword);
    const pdpShoeMode = !!(isShoe && shoeTargetNums.length > 0);

    // 靴PDP: prePdpScanIndex 優先。次へ API は offset も同じカーソルとして使う
    const prePdpScanIn = pdpShoeMode
      ? Math.max(0, Math.floor(Number(body.prePdpScanIndex ?? body.offset) || 0))
      : 0;

    console.log(
      '[AUDIT][search] mallQuery v2-test',
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
      try {
        console.log('[RE_EYE_TRACE][search:resp]', JSON.stringify({ exit: 'mallQuery_empty', itemsLen: 0 }));
      } catch (_) {
        /* */
      }
      setNoStore(res);
      return res.status(200).json({
        found: false,
        items: [],
        userSettings: userSettingsForResponse(settings),
        normalizedKeyword: normalizeBrand(stripSizeCmFromDisplayKeyword(baseKeyword)),
        inventoryRuleNoHits: true,
        inventorySizeVerifyAtPdp: true,
        searchMeta: { circuitState },
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
        shoeTargetNums,
        plan: effectivePlan,
        prePdpScanIn,
        excludeKeysArr: excludeKeys,
        excludeSellerModelKeysArr: excludeSellerModelKeys,
        sequentialPdp,
        sequentialCap: sequentialPdp ? limit : STOCK_SEQUENTIAL_CAP_DEFAULT,
      });

      const displayTrim = stripSizeCmFromDisplayKeyword(baseKeyword);
      const t1 = Date.now();
      const marketNewCount = r.poolLength || 0;
      const mapItem = (it) => ({
        ...it,
        itemKey: it.itemKey || itemCanonicalKey(it),
        dedupeSellerModel: it.dedupeSellerModel || sellerModelDedupeKey(it),
      });
      const itemsOut = (r.displayItems || []).map(mapItem);
      /* AND 規約: PDP 未取得は表示不可 → FREE は PDP を叩かず常にサイズ門前で不一致 */
      const itemsFinal = effectivePlan === 'FREE' ? [] : itemsOut;
      const nextStartingItem =
        effectivePlan === 'FREE' ? null : r.nextStartingItem ? mapItem(r.nextStartingItem) : null;
      const inventorySizeVerifyAtPdp =
        itemsFinal.length === 0 ||
        !itemsFinal.some(
          (x) => x.pdpSizeCheck && x.pdpSizeCheck.ok === true && !x.pdpSizeCheck.tentative
        );

      try {
        console.log(
          '[RE_EYE_TRACE][search:resp]',
          JSON.stringify({
            exit: 'pdp-shoe-json',
            itemsLen: itemsFinal.length,
            itemsOutRaw: itemsOut.length,
            poolLengthReported: r.poolLength,
            beforePdpBins: r.beforePdp,
            marketNewCount,
            stopReason: r.stopReason,
            sequentialPdp: !!sequentialPdp,
            plan: effectivePlan,
            mallPerKw: (r.perKw || []).map((x) => ({ kw: x.kw, items: x.items, err: x.error })),
          })
        );
      } catch (_) {
        /* */
      }

      setNoStore(res);
      const us = userSettingsForResponse(settings);
      return res.status(200).json({
        found: itemsFinal.length > 0,
        items: itemsFinal,
        nextStartingItem,
        userSettings: us,
        marketNewFound: marketNewCount > 0,
        marketNewCount,
        rejectReasonSummary: r.rejectReasonSummary || null,
        /** 運び屋メタ: debug 以外でも都道府県等を追える（将来送料 API 用に prefecture 同梱） */
        searchMeta: {
          sizeMode: 'cm',
          pdpShoe: true,
          carrier: sequentialPdp ? 'sequential-pdp-batch' : 'ranked-pdp-parallel-6',
          userSettings: us,
          mallPageBudget: r.staged && r.staged.maxMallPagesThisRequest,
          maxPdpBudget: r.staged && r.staged.maxPdpThisRequest,
          pdpCallsActual: r.pdpCalls,
          circuitState,
        },
        normalizedKeyword: normalizeBrand(displayTrim),
        inventoryRuleNoHits: (r.poolLength || 0) > 0 && itemsOut.length === 0,
        inventorySizeVerifyAtPdp,
        limit: sequentialPdp ? (r.staged && r.staged.seek) || limit : PDP_PER_RESPONSE,
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
          effectivePlan,
          profileFromRedis: {
            shoeCm: settings.shoeCm != null ? settings.shoeCm : null,
            clothing: settings.clothing != null ? settings.clothing : null,
            prefecture: settings.prefecture != null ? settings.prefecture : null,
          },
          counts: {
            poolLength: r.poolLength,
            pdpShoe: {
              before: r.beforePdp,
              display: itemsFinal.length,
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
            marketNewCount,
          },
        },
      });
    }

    // ── 服・靴以外: オフセット + limit（PDP なし）＋ モール拡張
    const seenMall = new Set();
    const allRaw = [];
    let mallP = 1;
    let perKw = [];
    let mallMeta = { marketRaw: 0, noiseExcluded: 0 };
    let lastRejectSummary = null;
    const targetEnd = listOffset + limit;
    while (mallP <= MAX_MALL_PAGE) {
      const r0 = applyMallItemFilters(
        buildCleanItemsFromRaw([...allRaw]),
        baseKeyword,
        requiredModels,
        isCloth,
        settings,
        forChild
      );
      const pool0 = r0.pool;
      lastRejectSummary = r0.rejectReasonSummary;
      if (pool0.length >= targetEnd) break;
      const { allItems, shopResults, meta } = await fetchMallPageSliceForKeywordList(kwList, mallP, HITS_PER_PAGE);
      perKw = toPerKwLog(shopResults, kwList);
      if (meta) {
        mallMeta.marketRaw += Number(meta.marketRaw) || 0;
        mallMeta.noiseExcluded += Number(meta.noiseExcluded) || 0;
      }
      mallP++;
      if (!allItems || allItems.length === 0) {
        break;
      }
      pushUniqueMallItems(allRaw, allItems, seenMall);
      try {
        console.log(
          '[RE_EYE_TRACE][search:non-shoe-mall]',
          JSON.stringify({
            mallPageVisited: mallP - 1,
            apiReturnedRowCount: Array.isArray(allItems) ? allItems.length : 0,
            afterDedupeUniqueRows: allRaw.length,
            meta: mallMeta || {},
          })
        );
      } catch (_) {
        /* */
      }
    }
    if (allRaw.length === 0) {
      try {
        console.log('[RE_EYE_TRACE][search:resp]', JSON.stringify({ exit: 'no_mall_items', itemsLen: 0, mallRaw: mallMeta }));
      } catch (_) {
        /* */
      }
      const displayTrim0 = stripSizeCmFromDisplayKeyword(baseKeyword);
      setNoStore(res);
      return res.status(200).json({
        found: false,
        items: [],
        userSettings: userSettingsForResponse(settings),
        normalizedKeyword: normalizeBrand(displayTrim0),
        marketNewFound: false,
        marketNewCount: 0,
        rejectReasonSummary: { marketRaw: mallMeta.marketRaw || 0, noiseExcluded: mallMeta.noiseExcluded || 0 },
        inventoryRuleNoHits: true,
        inventorySizeVerifyAtPdp: true,
        searchMeta: {
          circuitState,
          sizeMode: detectSizeMode({
            category: isCloth || isAccessoryGlove ? 'cloth' : 'other',
            keyword: baseKeyword,
          }),
        },
        searchCursor: { hasMore: false, listOffset, limit },
        debug: { note: 'no_mall_items', baseKeyword: displayTrim0 },
      });
    }

    const cleanItems = buildCleanItemsFromRaw(allRaw);
    const marketNewCount = cleanItems.length;
    const r1 = applyMallItemFilters(
      cleanItems,
      baseKeyword,
      requiredModels,
      isCloth,
      settings,
      forChild
    );
    let pool = r1.pool;
    lastRejectSummary = r1.rejectReasonSummary || lastRejectSummary;

    // ── stockFilterLayer 3段階（非靴パス） ───────────────────
    const rawCount    = pool.length;
    const stage1      = pool.filter(isItemInStock);
    const stage2      = stage1.filter(isActuallyPurchasable);
    const finalPool   = dedupeByUrl(stage2);
    const stockExcluded = rawCount - finalPool.length;
    console.log(
      `[stockFilter] non-shoe: raw=${rawCount} stage1=${stage1.length} stage2=${stage2.length} final=${finalPool.length}`
    );
    pool = finalPool;
    if (lastRejectSummary) lastRejectSummary.stockExcluded = stockExcluded;

    pool = sortByPriceAsc(pool);

    const sizeModeList = detectSizeMode({
      category: isCloth || isAccessoryGlove ? 'cloth' : 'other',
      keyword: baseKeyword,
    });
    if (sizeModeList === 'alpha') {
      const alphaTargets = resolveAlphaTargets(settings, { keyword: baseKeyword });
      pool = pool.map((it) => mapClothItemWithSizeGate(it, alphaTargets)).filter(Boolean);
    }

    const poolLength = pool.length;
    try {
      console.log(
        '[RE_EYE_TRACE][search:non-shoe-filter]',
        JSON.stringify({
          mallDedupCleanRows: cleanItems.length,
          afterFilterPool: poolLength,
          listOffset,
          limit,
        })
      );
    } catch (_) {
      /* */
    }
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
    try {
      console.log('[RE_EYE_TRACE][search:resp]', JSON.stringify({
        exit: 'non-shoe-json',
        itemsLen: slice.length,
        poolLength,
      }));
    } catch (_) {
      /* */
    }
    const displayTrim = stripSizeCmFromDisplayKeyword(baseKeyword);
    setNoStore(res);
    return res.status(200).json({
      found: slice.length > 0,
      items: slice,
      userSettings: userSettingsForResponse(settings),
      normalizedKeyword: normalizeBrand(displayTrim),
      marketNewFound: marketNewCount > 0,
      marketNewCount,
      rejectReasonSummary: { ...(lastRejectSummary || {}), ...(mallMeta || {}) },
      inventoryRuleNoHits: cleanItems.length > 0 && pool.length === 0,
      inventorySizeVerifyAtPdp: true,
      searchMeta: {
        circuitState,
        sizeMode: sizeModeList,
      },
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
          marketNewCount,
        },
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
