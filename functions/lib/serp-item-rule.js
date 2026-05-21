/**
 * SERP 用エントリ組み立て・poll サイズランク。キーワード錨の PDP 判定は serp-v5-pipeline の serpV5AnchorProgramMatch。
 */

import { extractModelNumbers, extractSizeFromKeyword, hasSizeInTitleUniversal } from './cross-validator.js';
<<<<<<< HEAD
import {
  validateColorMatchForItem,
  extractColorKeywords,
  buildSerpPlainTextHaystack,
} from './color-filter.js';
import { matchesProductKeyword } from './keyword-match.js';
import { normalizeBrand, normalizeBrandForCanonical } from './brand-normalizer.js';
=======
import { extractColorKeywords, buildSerpPlainTextHaystack } from './color-filter.js';
>>>>>>> 5cd0cd18d44d8972bc0f36c1caefc506e3d91796

/** 監視・SERP 服サイズ（アルファ6種のみ） */
const CLOTHING = ['XXL', 'XL', 'L', 'M', 'S', 'XS'];

/**
 * colorKeywords で付いた cm が fail-close と整合するときだけ靴 sizeInfo にする。
 * @param {string} s
 * @returns {{ type: 'shoe', raw: string }|null}
 */
function strictShoeSizeInfoFromToken(s) {
  const t = String(s ?? '').trim();
  if (/[-〜~\u2013\u2014]/.test(t) || /約|前後/.test(t)) return null;
  const m = t.match(/^(\d{1,2}(?:\.\d)?)\s*cm$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 14 || n > 35) return null;
  const canon = Math.round(n * 10) / 10;
  const raw = canon % 1 === 0 ? String(Math.trunc(canon)) : canon.toFixed(1);
  return { type: 'shoe', raw };
}

// ── 正規化関数（entry / item 両側で共通利用）─────────────────────────────────

/**
 * SKU を canonical 形式へ正規化する。
 * - 大文字化
 * - 区切り文字（スペース / _ / /）→ "-" に統一
 * - 連続ハイフン → 単一に圧縮
 * - 前後トリム
 *
 * 例: "cw2288 111" → "CW2288-111"
 *     "CW2288_111" → "CW2288-111"
 *     "CW2288/111" → "CW2288-111"
 */
export function normalizeSku(str) {
  return String(str || '')
    .trim()
    .toUpperCase()
    .replace(/[\s_\/]+/g, '-')  // スペース・_・/ → ハイフン
    .replace(/-{2,}/g, '-')     // 連続ハイフン → 単一に圧縮
    .replace(/^-|-$/g, '');     // 前後ハイフン除去
}

/**
 * サイズ文字列から数値・服サイズ表記のみを抽出して正規化する。
 * "26.5cm" / "26.5" → "26.5"   "L" / "l" → "L"   "US8.5" → extractSizeFromKeyword で cm 変換
 */
export function normalizeSize(str) {
  if (!str) return '';
  const s = String(str).trim();
  // cm 付き or 数値のみ → 小数 1 桁に統一
  const cm = s.match(/^(\d{2}(?:\.\d)?)(?:cm)?$/i);
  if (cm) return parseFloat(cm[1]).toFixed(1).replace(/\.0$/, '');
  // 服サイズ: S/M/L/XL 系 → 大文字
  if (/^(4XL|3XL|2XL|XXL|XL|XS|S|M|L)$/i.test(s)) return s.toUpperCase();
  return s;
}

/** 色文字列を比較可能な形式へ（小文字・trim） */
export function normalizeColor(str) {
  return String(str || '').trim().toLowerCase();
}

/**
 * アダプター共通 normalize 関数（adapter 層の責務）。
 * 楽天・Yahoo・公式・オークション等の item を matcher が扱える共通形式へ変換する。
 *
 * 呼び出しタイミング: shop-adapters/index.js の searchAll() 内で filterNoise 後に実行。
 * matcher (serpItemMatchesRule) は _enriched 済みの item のみを受け取る前提。
 *
 * 保証する出力フィールド:
 *   brand, sku, skuAll, size, sizeInfo, color, canonical_id, source
 *
 * @param {object} item adapter が返した生 item（破壊的に正規化フィールドを追加する）
 * @returns {object} 同じ item 参照（chain 可能）
 */
export function enrichItemStructure(item) {
  if (!item || item._enriched) return item;
  const hay = buildSerpPlainTextHaystack(item);

  // source: matcher 内でのソース識別に使用（sourceId の alias）
  item.source = item.sourceId || '';

  // brand: canonical_id 生成専用の正規化（表記揺れを canonical 大文字 ID に統一）
  item.brand = normalizeBrandForCanonical(item.brand || '');

  // sku: title/haystack から品番トークンを抽出（複数あれば全て保持）
  const skus = extractModelNumbers(hay);
  item.sku    = skus.length > 0 ? normalizeSku(skus[0]) : '';
  item.skuAll = skus.map(normalizeSku);

  // size: cm / 服サイズを抽出（最初の1つ）
  const sizeInfo = extractSizeFromKeyword(hay);
  item.size     = sizeInfo ? normalizeSize(sizeInfo.raw) : '';
  item.sizeInfo = sizeInfo || null;

  // color: 色語を抽出（最初の1つ）
  const colors = extractColorKeywords(hay);
  item.color = colors.length > 0 ? normalizeColor(colors[0]) : '';

  // canonical_id: brand:sku:size 形式（ショップ横断の重複通知排除キー）
  // sku が取れた場合のみ確定する（sku なしでは横断同一性を保証できない）
  item.canonical_id = item.sku
    ? [item.brand, item.sku, item.size].filter(Boolean).join(':')
    : '';

  item._enriched = true;
  return item;
}

/**
 * entry 側の canonical_id を生成する（登録時の構造化フィールドから）。
 * monitor.js の通知 payload に付加するために使用。
 *
 * @param {{ brand?: string, sku?: string, size?: string }} entry
 * @returns {string}  例: "NIKE:CW2288-111:26.5"  sku なしなら空文字
 */
export function buildEntryCanonicalId(entry) {
  const cBrand = normalizeBrandForCanonical(entry.brand || '');
  const cSku   = normalizeSku(entry.sku   || '');
  const cSize  = normalizeSize(entry.size  || '');
  return cSku ? [cBrand, cSku, cSize].filter(Boolean).join(':') : '';
}

/**
 * キーワード内の cm 表記 + entry.colorKeywords の数字・服サイズを sizeInfo 化（重複除去）
 * @param {{ colorKeywords?: string[] }} entry
 * @param {string} keyword
 */
export function collectRequiredSizeInfos(entry, keyword) {
  const out = [];
  const seen = new Set();
  const push = si => {
    if (!si) return;
    const k = `${si.type}:${si.raw}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(si);
  };
  push(extractSizeFromKeyword(keyword));
  for (const ck of entry.colorKeywords || []) {
    const s = String(ck ?? '').trim();
    if (!s) continue;
    const sho = strictShoeSizeInfoFromToken(s);
    if (sho) {
      push(sho);
    } else {
      const u = s.toUpperCase();
      if (CLOTHING.includes(u)) push({ type: 'clothing', raw: u });
    }
  }
  return out;
}

/**
 * 監視 Redis エントリと同型のルール入力を、検索キーワードから組み立てる（検索 API 用）。
 * @param {string} trimmed サイズ注入後の検索語
 */
export function buildSerpRuleEntryForKeyword(trimmed) {
  return {
    keyword: trimmed,
    colorKeywords: extractColorKeywords(trimmed),
    modelNumbers: extractModelNumbers(trimmed),
  };
}

<<<<<<< HEAD
/**
 * matcher 判定結果を Redis List へ fire-and-forget で保存する。
 *
 * コスト最適化: FAIL（誤検知）のみ保存。PASS は保存しない。
 *   logs:misdetect:{YYYYMMDD} — FAIL のみ（Redis コマンド 2件/FAIL）
 *
 * Redis 障害時は例外を握り潰し matcher を止めない。
 */
async function _saveMatchLog(r, entry, item, matchLog, result, reason) {
  // PASS はログしない（コスト削減: Redisコマンド数をFAILのみに限定）
  if (result) return;
  try {
    const now          = new Date();
    const dateKey      = now.toISOString().slice(0, 10).replace(/-/g, '');
    const ts           = now.toISOString();
    const entryCanonId = entry.canonical_id || buildEntryCanonicalId(entry) || '';
    const itemCanonId  = item.canonical_id  || '';
    const step         = matchLog.step || 'UNKNOWN';

    const mdKey = `logs:misdetect:${dateKey}`;
    await r.lpush(mdKey, JSON.stringify({
      ts,
      reason:             reason || 'unknown',
      step,
      canonical_id_entry: entryCanonId,
      canonical_id_item:  itemCanonId,
      title:              (item.title || '').slice(0, 80),
      expected:           false,
    }));
    await r.ltrim(mdKey, 0, 2999);
  } catch (e) {
    console.warn('[matcher-log] Redis 保存失敗（matcher は継続）:', e.message);
  }
}

/**
 * キーワード・色・品番・サイズが商品テキストと整合するか（プログラム判定）
 * @param {{ keyword?: string, colorKeywords?: string[], modelNumbers?: string[] }} entry
 * @param {object} item 楽天・Yahoo 正規化アイテム（available = API の在庫フラグ想定）
 * @param {{ relaxSizeWhenInStock?: boolean, inventoryListingSearch?: boolean, redis?: object }} [opts]
 *   relaxSizeWhenInStock: 本文にサイズが無くても API が在庫ありならサイズ条件だけ通す
 *   inventoryListingSearch: POST /api/search 在庫検索向け。
 *   redis: Upstash Redis クライアント（渡した場合のみ判定ログを保存）
 */
export function serpItemMatchesRule(entry, item, opts = {}) {
  const { relaxSizeWhenInStock = false, inventoryListingSearch = false, redis } = opts;
  const keyword    = entry.keyword || '';
  const normalized = normalizeBrand(keyword);
  const hay        = buildSerpPlainTextHaystack(item);

  // safety-guard: 通常は searchAll() → enrichItemStructure() 済みで到達する。
  // enrichItemStructure を経由しない呼び出し元（テスト・旧コードパス）向けの保険。
  if (!item._enriched) enrichItemStructure(item);

  // titleTokens は item.sku が存在しない場合のフォールバック用としてのみ生成
  let _titleTokens = null;
  const getTitleTokens = () => {
    if (!_titleTokens) _titleTokens = hay.toUpperCase().split(/[\s\/\_\[\]【】（）()・,]+/).filter(Boolean);
    return _titleTokens;
  };

  // ── 判定結果を構造化ログとして収集 ──────────────────────────────────────
  // step: どのステップで判定終了したかを記録（data_quality ログ・ダッシュボード用）
  const matchLog = { sku: null, size: null, color: null, keyword: null, step: null };

  // Redis ログ保存 + return を一本化（fire-and-forget）
  const decide = (result, reason) => {
    console.log('[SERP] 判定結果:', matchLog, result ? '✅ PASS' : `❌ FAIL(${reason})`, `title="${(item.title || '').slice(0, 45)}"`);
    if (redis) _saveMatchLog(redis, entry, item, matchLog, result, reason).catch(() => {});
    return result;
  };

  // ── ⓪ canonical_id 完全一致（最優先）────────────────────────────────────
  // stored 値のみで比較する（動的補完は行わない）。
  // 片方でも空なら下位軸（SKU→size→color→keyword）へフォールバック。
  const entryCanonId = String(entry.canonical_id || '').trim();
  const itemCanonId  = String(item.canonical_id  || '').trim();
  if (entryCanonId && itemCanonId) {
    const matched = entryCanonId === itemCanonId;
    matchLog.sku = matchLog.size = matchLog.color = matched;
    matchLog.step = 'STEP0';
    return decide(matched, matched ? '' : `canonical_id:${entryCanonId}≠${itemCanonId}`);
  }

  // ── ① SKU 主軸判定 ────────────────────────────────────────────────────────
  // 優先: entry.sku vs item.sku（直接比較）
  // fallback: titleTokens split ベース（item.sku が取れなかった場合）
  const entrySku = normalizeSku(entry.sku);
  if (entrySku) {
    if (item.sku) {
      // item.sku が構造化済み → 直接比較
      matchLog.sku = item.skuAll.includes(entrySku);
    } else {
      // item.sku 未抽出 → titleTokens フォールバック
      matchLog.sku = getTitleTokens().includes(entrySku);
    }
    if (!matchLog.sku) { matchLog.step = 'SKU'; return decide(false, `sku=${entrySku}`); }
  } else {
    // entry.sku 未指定 → modelNumbers フォールバック
    const models = entry.modelNumbers || [];
    if (models.length > 0) {
      const tokens = getTitleTokens();
      matchLog.sku = models.some(m => tokens.includes(normalizeSku(m)));
      if (!matchLog.sku) { matchLog.step = 'SKU'; return decide(false, `modelNumbers=[${models.join(',')}]`); }
    }
  }

  // ── ② color 主軸判定（entry.color が存在する場合は keyword の色推測より優先）
  const primaryColor = entry.color ? String(entry.color).trim() : '';
  if (primaryColor) {
    matchLog.color = validateColorMatchForItem(item, primaryColor);
    if (!matchLog.color) { matchLog.step = 'COLOR'; return decide(false, `color=${primaryColor}`); }
  } else {
    // color 未指定時は keyword ベースの色フィルター
    if (!validateColorMatchForItem(item, keyword)) {
      matchLog.color = false;
      matchLog.step = 'COLOR';
      return decide(false, 'color(keyword)');
    }
    matchLog.color = true;
  }

  // ── ③ size 主軸判定（entry.size が存在する場合は keyword 抽出より優先）──
  const primarySizeInfo = entry.size
    ? extractSizeFromKeyword(entry.size + 'cm') || extractSizeFromKeyword(entry.size)
    : null;
  const sizeInfos = primarySizeInfo
    ? [primarySizeInfo]
    : collectRequiredSizeInfos(entry, keyword);

  for (const si of sizeInfos) {
    if (!hasSizeInTitleUniversal(hay, si)) {
      const relaxable = si.type === 'shoe' || si.type === 'clothing' || si.type === 'numeric';
      if (relaxSizeWhenInStock && item.available === true && relaxable) {
        console.log(`[SERP] サイズ緩和通過（API 在庫あり）: ${si.type}=${si.raw}`);
        continue;
      }
      if (inventoryListingSearch && relaxable) {
        console.log(`[SERP] 在庫検索API サイズ緩和: ${si.type}=${si.raw}`);
        continue;
      }
      matchLog.size = false;
      matchLog.step = 'SIZE';
      return decide(false, `size=${si.type}:${si.raw}`);
    }
  }
  matchLog.size = sizeInfos.length > 0 ? true : null;

  // ── ④ keyword キーワード一致（補助軸）────────────────────────────────────
  // entry.sku または canonical_id が存在する場合は構造化フィールドで判定済み。
  // keyword は検索クエリ専用であるため、ここでの判定はスキップする。
  const hasStructuredId = !!(normalizeSku(entry.sku) || entry.canonical_id);
  if (!hasStructuredId) {
    if (!matchesProductKeyword(item, keyword, normalized)) {
      matchLog.keyword = false;
      matchLog.step = 'KEYWORD';
      return decide(false, 'keyword');
    }
    matchLog.keyword = true;
    matchLog.step = 'KEYWORD';
  } else {
    matchLog.keyword = null; // 構造化判定済みのためスキップ
    // PASS 時の step: 使用した最上位軸を記録
    if (matchLog.sku !== null)   matchLog.step = 'SKU';
    else if (matchLog.size !== null)  matchLog.step = 'SIZE';
    else if (matchLog.color !== null) matchLog.step = 'COLOR';
  }

  return decide(true, '');
}

=======
>>>>>>> 5cd0cd18d44d8972bc0f36c1caefc506e3d91796
// ── poll 用: マイサイズ A/B/C（厳格: 本文にマイサイズが無ければ在庫フラグで繰り上げない）────────

/** user-settings 保存形と整合（長い表記を先に試す） */
const POLL_CLOTHING_FOR_SIGNAL = ['XXL', 'XL', 'L', 'M', 'S', 'XS'];

const SHOE_CM_IN_TEXT = /(\d{2}(?:\.\d)?)\s*cm/gi;

/**
 * Redis のユーザー設定オブジェクトから、poll が使う sizeInfo を1つ選ぶ。
 * 優先: shoeCm → clothing → numeric（user-settings.js の意図に合わせる）
 *
 * @param {{ shoeCm?: number|null, clothing?: string|null, numeric?: number|null }} settings
 * @returns {{ type: 'shoe'|'clothing'|'numeric', raw: string }|null}
 */
export function pickPollMySizeInfoFromSettings(settings) {
  if (!settings || typeof settings !== 'object') return null;
  const shoeN =
    typeof settings.shoeCm === 'number' && Number.isFinite(settings.shoeCm)
      ? settings.shoeCm
      : settings.shoeCm != null && settings.shoeCm !== ''
        ? Number(settings.shoeCm)
        : NaN;
  if (Number.isFinite(shoeN)) {
    const r = Math.round(shoeN * 10) / 10;
    if (r < 20.0 || r > 35.0) return null;
    const raw = Number.isInteger(r) ? String(r) : r.toFixed(1);
    return { type: 'shoe', raw };
  }
  if (typeof settings.clothing === 'string' && settings.clothing.trim()) {
    return { type: 'clothing', raw: settings.clothing.trim().toUpperCase() };
  }
  const numN =
    typeof settings.numeric === 'number' && Number.isFinite(settings.numeric)
      ? settings.numeric
      : settings.numeric != null && settings.numeric !== ''
        ? Number(settings.numeric)
        : NaN;
  if (Number.isFinite(numN)) {
    const i = Math.round(numN);
    if (i < 20 || i > 60) return null;
    return { type: 'numeric', raw: String(i) };
  }
  return null;
}

function hayHasAnyShoeCmSignal(hay) {
  if (!hay) return false;
  const t = String(hay);
  let m;
  SHOE_CM_IN_TEXT.lastIndex = 0;
  while ((m = SHOE_CM_IN_TEXT.exec(t)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v) && v >= 20.0 && v <= 35.0) return true;
  }
  return false;
}

function hayHasAnyClothingSizeSignal(hay) {
  if (!hay) return false;
  for (const raw of POLL_CLOTHING_FOR_SIGNAL) {
    if (hasSizeInTitleUniversal(hay, { type: 'clothing', raw })) return true;
  }
  return false;
}

/**
 * poll 用サイズランク（厳格）。
 * - A: 本文（SERP と同じ haystack）にマイサイズが現れる
 * - B: A ではないが、同一軸で「他サイズの痕跡」が本文にある（靴=20〜35cm、服=許容トークン）
 * - C: 上記以外（本文にマイサイズも他サイズの根拠も弱い。在庫ありでも繰り上げない）
 *
 * @param {object} item 楽天・Yahoo 正規化アイテム
 * @param {{ shoeCm?: number|null, clothing?: string|null, numeric?: number|null }} settings
 * @returns {'A'|'B'|'C'|null}  設定が無いとき null（ソート・付与しない）
 */
export function computePollSizeRank(item, settings) {
  const sizeInfo = pickPollMySizeInfoFromSettings(settings);
  if (!sizeInfo) return null;
  // 検索結果配列に null/欠損が混じると buildSerpPlainTextHaystack が落ちる（Vercel 500）
  if (!item || typeof item !== 'object') return 'C';
  const hay = buildSerpPlainTextHaystack(item);
  if (hasSizeInTitleUniversal(hay, sizeInfo)) return 'A';
  if (sizeInfo.type === 'shoe') {
    return hayHasAnyShoeCmSignal(hay) ? 'B' : 'C';
  }
  if (sizeInfo.type === 'clothing') {
    return hayHasAnyClothingSizeSignal(hay) ? 'B' : 'C';
  }
  return 'C';
}

const POLL_RANK_ORDER = { A: 0, B: 1, C: 2 };

/**
 * 各 item に sizeRank を付与し、A→B→C の安定ソートを返す。
 * マイサイズ未設定のときは配列も要素も変更しない。
 *
 * @param {object[]} items
 * @param {{ shoeCm?: number|null, clothing?: string|null, numeric?: number|null }|null} settings
 * @returns {object[]}
 */
export function stampPollSizeRankAndSort(items, settings) {
  if (!items?.length) return items || [];
  if (!pickPollMySizeInfoFromSettings(settings)) return items;

  const decorated = items.map((item, idx) => ({
    item,
    idx,
    rank: computePollSizeRank(item, settings),
  }));
  decorated.sort((a, b) => {
    const oa = POLL_RANK_ORDER[a.rank];
    const ob = POLL_RANK_ORDER[b.rank];
    if (oa !== ob) return oa - ob;
    return a.idx - b.idx;
  });
  for (const { item, rank } of decorated) {
    if (item && typeof item === 'object') item.sizeRank = rank;
  }
  return decorated.map(d => d.item);
}
