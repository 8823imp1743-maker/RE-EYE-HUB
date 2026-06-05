/**
 * PDP 在庫（最終方針）
 *
 * === チャット冒頭用お守り（このファイルに手を入れる会話の先頭に貼る） ===
 * 「既存の no_size_but_buyable や getBodyStructuredText といった曖昧な文字列一致に頼る古い経路はすべて廃止・削除し、今回定義した hasStructuralSize（構造判定）をメインゲートとする新ロジックに一本化してください。」
 * 回帰: リポジトリ直下で npm test（scripts/pdp-legacy-guard.mjs ＋ node --test による先祖返り／精度低下の即検知）
 * ========================================================================
 *
 * 【廃止済み】no_size_but_buyable / getBodyStructuredText / 単体ボタン・aria のみでの購入判定 等は置かない。
 * メインゲート: **選択可能 UI ノードのみ** option / button / li / [role="option"]
 * と `data-size`（上記またはその子孫のみ）に `(?<![0-9.]){cm}(cm|㎝)`、同一ノード束に禁止語
 * 「約／前後／〜／-」無し。そのノードの **同一 main|article|section|form（なければ商域根）コンテナ**
 * に購入ホワイトリスト＋在庫否定無し。全文フラットだけでは通過しない。
 */

import { JSDOM } from 'jsdom';
import { itemCanonicalKey, sellerModelDedupeKey } from './stock-dedupe.js';
import {
  redisGetPdpCache,
  redisSetPdpCache,
  hydratePdpResultFromRedis,
  PDP_CACHE_TTL_SEC,
} from './pdp-redis-cache.js';
import { optionallyLogPdpDecision } from './pdp-learn-log.js';
import { opsJsonLog } from './notify-ops-log.js';

// ── PDP URL+cm キャッシュ & 同時実行ロック ───────────────────────────────
// 同一 URL を短時間で何度も叩かない（コスト削減）
const pdpCache = new Map();
const inFlight = new Map();
/** fetch 失敗は短 TTL で再試行しやすくする（秒） */
const PDP_FETCH_FAIL_CACHE_SEC = 15;

/**
 * @param {string} url
 * @param {string|string[]} rawCm
 */
function getCacheKey(url, rawCm) {
  const t =
    Array.isArray(rawCm) ? [...rawCm].map(String).sort().join(',') : String(rawCm || '');
  return `${String(url || '')}::${t}`;
}

/**
 * @param {string|string[]|number[]|null|undefined} inp
 * @returns {string[]}
 */
function coerceTargetCmStrings(inp) {
  if (inp == null) return [];
  if (Array.isArray(inp)) {
    const out = [];
    for (const x of inp) {
      const s = String(x)
        .replace(/cm$/i, '')
        .trim();
      if (/^\d{1,2}(?:\.\d)?$/.test(s)) {
        const n = parseFloat(s);
        if (Number.isFinite(n) && n >= 10 && n <= 35) out.push(s);
      }
    }
    return [...new Set(out)].sort();
  }
  const st = String(inp).trim();
  if (!st) return [];
  if (st.includes(',')) return coerceTargetCmStrings(st.split(/[,、]/));
  return coerceTargetCmStrings([st]);
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PAGE_NOT_FOUND = /お探しの商品は見つかりません|商品が存在しません|指定された商品は/iu;

/** 在庫・サイズ根拠に使わない: 2桁cm〜2桁cm、および罫囲いの広告レンジ */
const RE_SIZE_RANGE_BANNED = /\d{2}\s*cm\s*[-〜~∼]\s*\d{2}\s*cm/iu;
const RE_SIZE_RANGE_BANNED_BRACKET = /【\s*\d{2}\s*cm\s*[-〜~∼]\s*\d{2}\s*cm\s*】/giu;
const RE_SIZE_RANGE_BANNED_BRACKET_ASCII = /【\d{2}\s*cm-\d{2}\s*cm】/giu;
const RE_SIZE_RANGE_BANNED_BRACKET_TIGHT = /【\d{1,2}\s*cm-\d{1,2}\s*cm】/giu;

/**
 * 在庫判定用テキストからレンジ表記を一時的に取り除く
 * @param {string} t
 */
function stripBannedSizeRanges(t) {
  if (!t) return '';
  let s = String(t);
  s = s.replace(RE_SIZE_RANGE_BANNED_BRACKET, ' ');
  s = s.replace(RE_SIZE_RANGE_BANNED_BRACKET_ASCII, ' ');
  s = s.replace(RE_SIZE_RANGE_BANNED_BRACKET_TIGHT, ' ');
  s = s.replace(RE_SIZE_RANGE_BANNED, ' ');
  return s;
}

/** 明示的セールス不可（positive 評価の前に必ず評価） */
function pdpSignalsHardOutOfStock(s) {
  return /品切れ|売り切れ|在庫なし|SOLD\s*OUT|ソールド\s*アウト|完売(?:です|いたしました)?|取扱(?:い)?終了|購入できません|ご購入いただけません|販売(?:は)?終了しました|準備中|停止中|入荷待ち/i.test(
    String(s || ''),
  );
}

/**
 * header/footer/nav 除いた body クローン（商域テキストの根）
 * @param {import('jsdom').Document} doc
 */
function getCommerceSubtreeClone(doc) {
  if (!doc || !doc.body) return null;
  try {
    const clone = doc.body.cloneNode(true);
    const strip = 'header, footer, nav, [role=banner], [role=contentinfo], [role=navigation]';
    clone.querySelectorAll(strip).forEach((n) => n.remove());
    return clone;
  } catch {
    return null;
  }
}

/** ナビ除いた commerce に**これらの部分文字列のみ**あれば購入導線あり（ボタン存在・aria は見ない） */
const PDP_BUY_PHRASES_STRICT =
  /カートに入れる|購入手続きへ|今すぐ購入|購入する|Add to Cart|Buy Now/i;

/** data-size は button / li / option / role=option 上（またはその内側）のみ */
const PDP_SIZE_CLICK_HOST =
  'button, li, option, [role="option"]';

const PDP_SIZE_NODE_QUERY = 'option, button, li, [role="option"], [data-size]';

function nodeBlobForbiddenForSizeUi(blob) {
  const s = String(blob || '');
  if (/約|前後|くらい|程度/.test(s)) return true;
  if (/〜|~|∼|\u2013|\u2014/.test(s)) return true;
  if (/-/.test(s)) return true;
  return false;
}

/**
 * @param {Element} el
 */
function isEligibleSelectableSizeNode(el) {
  try {
    if (el.matches?.(PDP_SIZE_CLICK_HOST)) return true;
    if (el.hasAttribute?.('data-size') && el.closest(PDP_SIZE_CLICK_HOST)) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * @param {string} blob
 * @param {string} rawCm
 */
function nodeBlobMatchesShoeCmStrict(blob, rawCm) {
  if (!blob || !rawCm || nodeBlobForbiddenForSizeUi(blob)) return false;
  const t = stripBannedSizeRanges(String(blob)).replace(/\s+/g, ' ');
  if (!t) return false;
  if (/(約|およそ|前後|くらい|程度)\s*\d{2}(?:\.\d)?\s*(?:cm|㎝)/iu.test(t)) return false;
  if (/\d{2}(?:\.\d)?\s*(?:cm|㎝)\s*(?:前後|くらい|約)/iu.test(t)) return false;
  const esc = String(rawCm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![0-9.])${esc}(cm|㎝)`, 'iu').test(t);
}

/**
 * 選択可能UIノードに cm があり、同一コンテナ内に購入ホワイトリストがあり、在庫否定なし
 * @param {import('jsdom').Document} doc
 * @param {string} rawCm
 */
function hasShoeSizeUiWithBuyInSameContainer(doc, rawCm) {
  const commerceRoot = getCommerceSubtreeClone(doc);
  if (!commerceRoot || !rawCm) return false;
  try {
    for (const el of commerceRoot.querySelectorAll(PDP_SIZE_NODE_QUERY)) {
      if (!isEligibleSelectableSizeNode(el)) continue;
      const blob = [
        el.textContent,
        el.getAttribute?.('data-size'),
        el.getAttribute?.('value'),
        el.getAttribute?.('title'),
      ]
        .filter(Boolean)
        .join(' ');
      if (!nodeBlobMatchesShoeCmStrict(blob, rawCm)) continue;

      const container =
        el.closest('main, article, [role="main"], section, form') ?? commerceRoot;
      const cflat = stripBannedSizeRanges(String(container.textContent || '')).replace(/\s+/g, ' ');
      if (!cflat) continue;
      if (pdpSignalsHardOutOfStock(cflat)) continue;
      if (!PDP_BUY_PHRASES_STRICT.test(cflat)) continue;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** 監視 SERP／完成仕様：S / M / L / XL のみ（XS/XXL・数値服は別経路へ載せない） */
export const PDP_CLOTHING_ALPHAS = ['S', 'M', 'L', 'XL'];

/** @param {string} rawAlpha */
export function coerceTargetClothingAlpha(rawAlpha) {
  const u = String(rawAlpha ?? '')
    .trim()
    .toUpperCase();
  return PDP_CLOTHING_ALPHAS.includes(u) ? u : '';
}

function nodeBlobMatchesClothingAlphaStrict(blob, rawAlpha) {
  if (!blob || !rawAlpha || nodeBlobForbiddenForSizeUi(blob)) return false;
  const u = String(rawAlpha).toUpperCase().trim();
  if (!PDP_CLOTHING_ALPHAS.includes(u)) return false;
  const t = String(blob || '').replace(/\s+/g, ' ');
  if (!t) return false;
  const esc = u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (u === 'XL') {
    return /(^|[\s\u3000/・])XL(?=[\s\u3000]|サイズ|$|[)）])/i.test(t);
  }
  const re = new RegExp(`(^|[\\s\\u3000/・])${esc}(?=[\\s\\u3000]|サイズ|$|[)）]])`, 'i');
  return re.test(t);
}

/**
 * @param {import('jsdom').Document} doc
 * @param {string} rawAlpha S|M|L|XL
 */
function hasClothingSizeUiWithBuyInSameContainer(doc, rawAlpha) {
  const commerceRoot = getCommerceSubtreeClone(doc);
  if (!commerceRoot || !rawAlpha) return false;
  try {
    for (const el of commerceRoot.querySelectorAll(PDP_SIZE_NODE_QUERY)) {
      if (!isEligibleSelectableSizeNode(el)) continue;
      const blob = [
        el.textContent,
        el.getAttribute?.('data-size'),
        el.getAttribute?.('value'),
        el.getAttribute?.('title'),
      ]
        .filter(Boolean)
        .join(' ');
      if (!nodeBlobMatchesClothingAlphaStrict(blob, rawAlpha)) continue;

      const container =
        el.closest('main, article, [role="main"], section, form') ?? commerceRoot;
      const cflat = stripBannedSizeRanges(String(container.textContent || '')).replace(/\s+/g, ' ');
      if (!cflat) continue;
      if (pdpSignalsHardOutOfStock(cflat)) continue;
      if (!PDP_BUY_PHRASES_STRICT.test(cflat)) continue;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * サイズ選択 UI を要さない PDP（シール・バッグ等）：商域内に購入ホワイトリストがあり同一コンテナに在庫否定なし。
 * 単体 aria のみ・全文フラットのみでは通さない（靴／服と同系のコンテナ束ね）。
 * @param {import('jsdom').Document} doc
 */
function hasGenericStructuralBuyInCommerce(doc) {
  const commerceRoot = getCommerceSubtreeClone(doc);
  if (!commerceRoot) return false;
  const selectors = 'button, a[href], [role="button"], input[type="submit"], input[type="button"]';
  try {
    for (const el of commerceRoot.querySelectorAll(selectors)) {
      const blob = [
        el.textContent,
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('value'),
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      if (!blob || !PDP_BUY_PHRASES_STRICT.test(blob)) continue;
      const container =
        el.closest('main, article, [role="main"], section, form') ?? commerceRoot;
      const cflat = stripBannedSizeRanges(String(container.textContent || '')).replace(/\s+/g, ' ');
      if (!cflat) continue;
      if (pdpSignalsHardOutOfStock(cflat)) continue;
      if (!PDP_BUY_PHRASES_STRICT.test(cflat)) continue;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * v5.0：サイズなしカテゴリ／強制 PDP 用。reason=dom_structural のみ成功扱い。
 * @param {string} html
 * @param {string} [pdpUrl]
 */
export function analyzePdpHtmlForGenericStructuralBuy(html, pdpUrl = '') {
  if (!html || String(html).length < 500) {
    logPdpStrictReject('html_short', {
      len: html ? String(html).length : 0,
      pdpUrl,
      kind: 'generic_struct',
    });
    return {
      ok: false,
      reason: 'fetch_fail_strict',
      method: 'fetch',
      pdpTentative: false,
      retryable: true,
    };
  }

  let doc;
  try {
    doc = new JSDOM(String(html), { contentType: 'text/html' }).window.document;
  } catch {
    return { ok: false, reason: 'parse_error', method: 'dom', pdpTentative: false };
  }

  const bodyText = getBodyTextFlat(doc);
  const commerceText = getBodyTextMinusGlobalChrome(doc);

  if (!bodyText || bodyText.length < 20) {
    logPdpStrictReject('body_too_small', { pdpUrl, kind: 'generic_struct' });
    return { ok: false, reason: 'no_structural_size', method: 'dom', pdpTentative: false };
  }

  if (PAGE_NOT_FOUND.test(bodyText)) {
    return { ok: false, reason: 'pdp_page_error', method: 'none' };
  }

  const commerceStripped = stripBannedSizeRanges(commerceText);

  if (pdpSignalsHardOutOfStock(commerceStripped)) {
    logPdpStrictReject('hard_out_of_stock_commerce', { pdpUrl, kind: 'generic_struct' });
    return {
      ok: false,
      reason: 'out_of_stock',
      method: 'none',
      pdpTentative: false,
    };
  }

  if (!hasGenericStructuralBuyInCommerce(doc)) {
    return { ok: false, reason: 'no_structural_size', method: 'dom', pdpTentative: false };
  }

  return {
    ok: true,
    reason: 'dom_structural',
    method: 'structural',
    pdpTentative: false,
  };
}

export function analyzePdpHtmlForClothingAlpha(html, rawAlpha, pdpUrl = '') {
  const alpha = coerceTargetClothingAlpha(rawAlpha);
  if (!alpha) {
    logPdpStrictReject('clothing_bad_alpha', { pdpUrl });
    return { ok: false, reason: 'no_input', method: 'none' };
  }
  if (!html || String(html).length < 500) {
    logPdpStrictReject('html_short', {
      len: html ? String(html).length : 0,
      pdpUrl,
      targets: [alpha],
    });
    return {
      ok: false,
      reason: 'fetch_fail_strict',
      method: 'fetch',
      pdpTentative: false,
      retryable: true,
    };
  }

  let doc;
  try {
    doc = new JSDOM(String(html), { contentType: 'text/html' }).window.document;
  } catch {
    return { ok: false, reason: 'parse_error', method: 'dom', pdpTentative: false };
  }

  const bodyText = getBodyTextFlat(doc);
  const commerceText = getBodyTextMinusGlobalChrome(doc);

  if (!bodyText || bodyText.length < 20) {
    logPdpStrictReject('body_too_small', { pdpUrl });
    return { ok: false, reason: 'no_structural_size', method: 'dom', pdpTentative: false };
  }

  if (PAGE_NOT_FOUND.test(bodyText)) {
    return { ok: false, reason: 'pdp_page_error', method: 'none' };
  }

  const commerceStripped = stripBannedSizeRanges(commerceText);

  if (pdpSignalsHardOutOfStock(commerceStripped)) {
    logPdpStrictReject('hard_out_of_stock_commerce', { pdpUrl });
    return {
      ok: false,
      reason: 'out_of_stock',
      method: 'none',
      pdpTentative: false,
    };
  }

  if (!hasClothingSizeUiWithBuyInSameContainer(doc, alpha)) {
    return { ok: false, reason: 'no_structural_size', method: 'dom', targetCms: [alpha] };
  }

  return {
    ok: true,
    reason: 'dom_structural',
    method: 'structural',
    pdpTentative: false,
    matchedCm: alpha,
    targetCms: [alpha],
  };
}

/**
 * <body> の可視テキスト（head 完全除外）
 * @param {import('jsdom').Document} doc
 */
function getBodyTextFlat(doc) {
  if (!doc || !doc.body) return '';
  return String(doc.body.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400_000);
}

/**
 * 全ヘッダ/フッタ/大域ナビを除いた本文
 * @param {import('jsdom').Document} doc
 */
function getBodyTextMinusGlobalChrome(doc) {
  if (!doc || !doc.body) return '';
  try {
    const clone = doc.body.cloneNode(true);
    const strip = 'header, footer, nav, [role=banner], [role=contentinfo], [role=navigation]';
    clone.querySelectorAll(strip).forEach((n) => n.remove());
    return String(clone.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400_000);
  } catch {
    return getBodyTextFlat(doc);
  }
}

/**
 * 楽天アフィリ（hb.afl.rakuten）→ 商品直 URL。fetch 直前に必ず通す。
 * クエリのアフィ計測・追跡系は可能な範囲で除去してキャッシュキー安定化。
 */
export function normalizeRakutenUrl(url) {
  try {
    if (!url) return url;
    const s = String(url);
    if (s.includes('hb.afl.rakuten.co.jp')) {
      const m = s.match(/[?&]pc=([^&]+)/);
      if (m) return normalizeRakutenUrl(decodeURIComponent(m[1]));
    }
    if (!/^https?:\/\//i.test(s)) return s;
    const u = new URL(s);
    /** @param {string} k */
    const dropParam = (k) =>
      /^utm_/i.test(k) ||
      /^(iclid|iwch|icid|scid|(?:s-)?afid|m|cbf|cbfaid|vos|vosid|rakuten_ad)$/.test(k);
    for (const k of [...u.searchParams.keys()]) {
      if (dropParam(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 楽天アフィ中網はここで必ず正規化してから1回だけ fetch（リトライなし＝遅延抑制）。
 * @param {string} url 生の item.url（中継URLのままでよい）
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<string|null>}
 */
export async function fetchPdpHtml(url, timeoutMs = 8000) {
  const targetUrl = normalizeRakutenUrl(url);
  const u = targetUrl != null ? String(targetUrl) : '';
  if (!u || !/^https?:\/\//i.test(u)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(u, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) {
      opsJsonLog('pdp_fetch_http', {
        stage: 'pdp_fetch',
        url: u.slice(0, 200),
        status: res.status,
        ok: false,
      });
      return null;
    }
    const txt = await res.text();
    return typeof txt === 'string' && txt.length > 500 ? txt : null;
  } catch (e) {
    opsJsonLog('pdp_fetch_http', {
      stage: 'pdp_fetch',
      url: u.slice(0, 200),
      status: 0,
      ok: false,
      error: e?.name || 'Error',
      message: String(e?.message || e).slice(0, 240),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Record<string, unknown>} row */
export function logPdpStrictReject(tag, row) {
  try {
    console.log(`[PDP_STRICT][${tag}]`, JSON.stringify(row));
  } catch {
    console.log('[PDP_STRICT]', tag, row);
  }
}

export function analyzePdpHtmlForShoeCm(html, rawCm, pdpUrl = '') {
  const targets = coerceTargetCmStrings(rawCm);
  if (targets.length === 0) {
    logPdpStrictReject('no_targets', { pdpUrl, rawCmPreview: String(rawCm).slice(0, 32) });
    return { ok: false, reason: 'no_input', method: 'none' };
  }
  if (!html || String(html).length < 500) {
    logPdpStrictReject('html_short', {
      len: html ? String(html).length : 0,
      pdpUrl,
      targets,
    });
    return {
      ok: false,
      reason: 'fetch_fail_strict',
      method: 'fetch',
      pdpTentative: false,
      retryable: true,
    };
  }

  let doc;
  try {
    doc = new JSDOM(String(html), { contentType: 'text/html' }).window.document;
  } catch (e) {
    return { ok: false, reason: 'parse_error', method: 'dom', pdpTentative: false };
  }

  const bodyText = getBodyTextFlat(doc);

  if (!bodyText || bodyText.length < 20) {
    logPdpStrictReject('body_too_small', { pdpUrl });
    return { ok: false, reason: 'insufficient_body_strict', method: 'dom', pdpTentative: false };
  }

  if (PAGE_NOT_FOUND.test(bodyText)) {
    return { ok: false, reason: 'pdp_page_error', method: 'none' };
  }

  // 品切れ判定は全文ではなくサイズノード＋親コンテナ内（hasShoeSizeUiWithBuyInSameContainer）に限定

  const structuralCmHit = targets.find((cm) => hasShoeSizeUiWithBuyInSameContainer(doc, cm));
  if (!structuralCmHit) {
    return { ok: false, reason: 'no_structural_size', method: 'dom', targetCms: targets };
  }

  return {
    ok: true,
    reason: 'dom_structural',
    method: 'structural',
    pdpTentative: false,
    matchedCm: structuralCmHit,
    targetCms: targets,
  };
}

/** メモリ/Redis で再利用してよい PDP 結果（fail-close と矛盾する経路は保存しない／読まない） */
const PDP_RESULTS_CACHE_ALLOWED = new Set(['dom_structural']);

/**
 * @param {{ ok?: boolean|null; reason?: string; pdpTentative?: boolean }|null|undefined} r
 */
function pdpVerificationResultStrictCacheable(r) {
  return (
    !!r &&
    r.ok === true &&
    !r.pdpTentative &&
    PDP_RESULTS_CACHE_ALLOWED.has(String(r.reason || ''))
  );
}

/**
 * @param {{ url?: string, sourceId?: string }} item
 * @param {string|string[]} rawCm — 単一 cm 文字列または配列（ANY 一致）
 */
export async function verifyShoeSizeOnPdp(item, rawCm) {
  const url = item && item.url;
  const pdpUrl = normalizeRakutenUrl(url) || url || '';
  const key = getCacheKey(pdpUrl || url || '', rawCm);
  const now = Date.now();

  const cached = pdpCache.get(key);
  if (cached) {
    const age = now - cached.ts;
    const d = cached.data;
    if (age < PDP_FETCH_FAIL_CACHE_SEC * 1000 && d?.ok === false && d?.reason === 'fetch_fail_strict' && d?.retryable) {
      return d;
    }
    if (age < PDP_CACHE_TTL_SEC * 1000 && pdpVerificationResultStrictCacheable(d)) {
      return d;
    }
  }

  const redisHit = await redisGetPdpCache(pdpUrl, coerceTargetCmStrings(rawCm).join(',') || String(rawCm)).catch(
    () => null
  );
  if (redisHit && typeof redisHit.ok !== 'undefined') {
    const result = hydratePdpResultFromRedis(redisHit);
    if (pdpVerificationResultStrictCacheable(result)) {
      const rs = typeof redisHit.ts === 'number' ? redisHit.ts : now;
      pdpCache.set(key, { ts: rs, data: result });
      return result;
    }
    const recTs = typeof redisHit.ts === 'number' ? redisHit.ts : 0;
    if (
      result.ok === false &&
      result.reason === 'fetch_fail_strict' &&
      result.retryable &&
      recTs > 0 &&
      now - recTs < PDP_FETCH_FAIL_CACHE_SEC * 1000
    ) {
      return { ...result, ms: typeof result.ms === 'number' ? result.ms : 0 };
    }
  }

  if (inFlight.has(key)) {
    return await inFlight.get(key);
  }

  const promise = (async () => {
    const t0 = Date.now();
    const html = await fetchPdpHtml(url, 5000);

    let result;
    if (!html) {
      result = {
        ok: false,
        reason: 'fetch_fail_strict',
        method: 'fetch',
        pdpTentative: false,
        retryable: true,
        ms: Date.now() - t0,
      };
      logPdpStrictReject('verify_fetch_failed', {
        url: String(url || '').slice(0, 120),
        pdpUrl,
        size: rawCm,
      });
    } else {
      /** fail-close: パース／DOM で例外でも通過させない */
      let r;
      try {
        r = analyzePdpHtmlForShoeCm(html, rawCm, pdpUrl);
      } catch (err) {
        logPdpStrictReject('analyze_throw', {
          pdpUrl,
          msg: String(err && err.message ? err.message : err).slice(0, 200),
        });
        r = {
          ok: false,
          reason: 'analyze_throw_strict',
          method: 'dom',
          pdpTentative: false,
        };
      }
      result = { ...r, ms: Date.now() - t0 };
      console.log('[PDP CHECK]', { url, pdpUrl, size: rawCm, result });
    }

    const redisSuccess = pdpVerificationResultStrictCacheable(result);
    const redisFetchFail =
      result.ok === false &&
      String(result.reason || '') === 'fetch_fail_strict' &&
      result.retryable === true;

    if (redisSuccess || redisFetchFail) {
      pdpCache.set(key, { ts: now, data: result });
      const ttl = redisFetchFail ? PDP_FETCH_FAIL_CACHE_SEC : PDP_CACHE_TTL_SEC;
      await redisSetPdpCache(
        pdpUrl,
        coerceTargetCmStrings(rawCm).join(',') || String(rawCm),
        {
          ok: result.ok,
          reason: result.reason,
          method: result.method,
          pdpTentative: !!result.pdpTentative,
          retryable: !!result.retryable,
          ms: result.ms ?? 0,
          ts: now,
        },
        ttl,
      ).catch(() => {});
    }

    opsJsonLog('pdp_result', {
      ok: !!result.ok,
      reason: result.reason,
      retryable: !!result.retryable,
      url: String(pdpUrl || '').slice(0, 120),
    });
    optionallyLogPdpDecision({ canonicalUrl: pdpUrl, rawCm, result }).catch(() => {});
    return result;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * 服アルファサイズ（S/M/L/XL）のみ。靴 PDP とはキャッシュキー分離。
 * @param {{ url?: string, sourceId?: string }} item
 * @param {string} rawAlpha S|M|L|XL
 */
export async function verifyClothingSizeOnPdp(item, rawAlpha) {
  const url = item && item.url;
  const pdpUrl = normalizeRakutenUrl(url) || url || '';
  const alpha = coerceTargetClothingAlpha(rawAlpha);
  const cacheSlug = alpha ? `cloth:${alpha}` : 'cloth:_';
  const key = getCacheKey(pdpUrl || url || '', cacheSlug);
  const now = Date.now();

  const cached = pdpCache.get(key);
  if (cached) {
    const age = now - cached.ts;
    const d = cached.data;
    if (age < PDP_FETCH_FAIL_CACHE_SEC * 1000 && d?.ok === false && d?.reason === 'fetch_fail_strict' && d?.retryable) {
      return d;
    }
    if (age < PDP_CACHE_TTL_SEC * 1000 && pdpVerificationResultStrictCacheable(d)) {
      return d;
    }
  }

  const redisHit = await redisGetPdpCache(pdpUrl, cacheSlug).catch(() => null);
  if (redisHit && typeof redisHit.ok !== 'undefined') {
    const result = hydratePdpResultFromRedis(redisHit);
    if (pdpVerificationResultStrictCacheable(result)) {
      const rs = typeof redisHit.ts === 'number' ? redisHit.ts : now;
      pdpCache.set(key, { ts: rs, data: result });
      return result;
    }
    const recTs = typeof redisHit.ts === 'number' ? redisHit.ts : 0;
    if (
      result.ok === false &&
      result.reason === 'fetch_fail_strict' &&
      result.retryable &&
      recTs > 0 &&
      now - recTs < PDP_FETCH_FAIL_CACHE_SEC * 1000
    ) {
      return { ...result, ms: typeof result.ms === 'number' ? result.ms : 0 };
    }
  }

  if (!alpha) {
    return { ok: false, reason: 'no_input', method: 'none', pdpTentative: false, ms: 0 };
  }

  if (inFlight.has(key)) {
    return await inFlight.get(key);
  }

  const promise = (async () => {
    const t0 = Date.now();
    const html = await fetchPdpHtml(url, 3000);

    let result;
    if (!html) {
      result = {
        ok: false,
        reason: 'fetch_fail_strict',
        method: 'fetch',
        pdpTentative: false,
        retryable: true,
        ms: Date.now() - t0,
      };
      logPdpStrictReject('verify_fetch_failed_cloth', {
        url: String(url || '').slice(0, 120),
        pdpUrl,
        size: alpha,
      });
    } else {
      let r;
      try {
        r = analyzePdpHtmlForClothingAlpha(html, alpha, pdpUrl);
      } catch (err) {
        logPdpStrictReject('analyze_throw_cloth', {
          pdpUrl,
          msg: String(err && err.message ? err.message : err).slice(0, 200),
        });
        r = {
          ok: false,
          reason: 'analyze_throw_strict',
          method: 'dom',
          pdpTentative: false,
        };
      }
      result = { ...r, ms: Date.now() - t0 };
      console.log('[PDP CHECK CLOTH]', { url, pdpUrl, size: alpha, result });
    }

    const redisSuccess = pdpVerificationResultStrictCacheable(result);
    const redisFetchFail =
      result.ok === false &&
      String(result.reason || '') === 'fetch_fail_strict' &&
      result.retryable === true;

    if (redisSuccess || redisFetchFail) {
      pdpCache.set(key, { ts: now, data: result });
      const ttl = redisFetchFail ? PDP_FETCH_FAIL_CACHE_SEC : PDP_CACHE_TTL_SEC;
      await redisSetPdpCache(pdpUrl, cacheSlug, {
        ok: result.ok,
        reason: result.reason,
        method: result.method,
        pdpTentative: !!result.pdpTentative,
        retryable: !!result.retryable,
        ms: result.ms ?? 0,
        ts: now,
      }).catch(() => {});
    }

    opsJsonLog('pdp_result', {
      ok: !!result.ok,
      reason: result.reason,
      retryable: !!result.retryable,
      url: String(pdpUrl || '').slice(0, 120),
      kind: 'cloth',
    });
    optionallyLogPdpDecision({ canonicalUrl: pdpUrl, rawCm: alpha, result }).catch(() => {});
    return result;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * v5.0：サイズなし PDP（シール・化粧品・バッグ・強制 main）。キャッシュは URL＋固定スラッグ。
 * @param {{ url?: string, sourceId?: string }} item
 */
export async function verifyGenericMainStructuralBuyOnPdp(item) {
  const url = item && item.url;
  const pdpUrl = normalizeRakutenUrl(url) || url || '';
  const cacheSlug = 'generic:struct';
  const key = getCacheKey(pdpUrl || url || '', cacheSlug);
  const now = Date.now();

  const cached = pdpCache.get(key);
  if (cached) {
    const age = now - cached.ts;
    const d = cached.data;
    if (age < PDP_FETCH_FAIL_CACHE_SEC * 1000 && d?.ok === false && d?.reason === 'fetch_fail_strict' && d?.retryable) {
      return d;
    }
    if (age < PDP_CACHE_TTL_SEC * 1000 && pdpVerificationResultStrictCacheable(d)) {
      return d;
    }
  }

  const redisHit = await redisGetPdpCache(pdpUrl, cacheSlug).catch(() => null);
  if (redisHit && typeof redisHit.ok !== 'undefined') {
    const result = hydratePdpResultFromRedis(redisHit);
    if (pdpVerificationResultStrictCacheable(result)) {
      const rs = typeof redisHit.ts === 'number' ? redisHit.ts : now;
      pdpCache.set(key, { ts: rs, data: result });
      return result;
    }
    const recTs = typeof redisHit.ts === 'number' ? redisHit.ts : 0;
    if (
      result.ok === false &&
      result.reason === 'fetch_fail_strict' &&
      result.retryable &&
      recTs > 0 &&
      now - recTs < PDP_FETCH_FAIL_CACHE_SEC * 1000
    ) {
      return { ...result, ms: typeof result.ms === 'number' ? result.ms : 0 };
    }
  }

  if (inFlight.has(key)) {
    return await inFlight.get(key);
  }

  const promise = (async () => {
    const t0 = Date.now();
    const html = await fetchPdpHtml(url, 3000);

    let result;
    if (!html) {
      result = {
        ok: false,
        reason: 'fetch_fail_strict',
        method: 'fetch',
        pdpTentative: false,
        retryable: true,
        ms: Date.now() - t0,
      };
      logPdpStrictReject('verify_fetch_failed_generic', {
        url: String(url || '').slice(0, 120),
        pdpUrl,
      });
    } else {
      let r;
      try {
        r = analyzePdpHtmlForGenericStructuralBuy(html, pdpUrl);
      } catch (err) {
        logPdpStrictReject('analyze_throw_generic', {
          pdpUrl,
          msg: String(err && err.message ? err.message : err).slice(0, 200),
        });
        r = {
          ok: false,
          reason: 'analyze_throw_strict',
          method: 'dom',
          pdpTentative: false,
        };
      }
      result = { ...r, ms: Date.now() - t0 };
    }

    const redisSuccess = pdpVerificationResultStrictCacheable(result);
    const redisFetchFail =
      result.ok === false &&
      String(result.reason || '') === 'fetch_fail_strict' &&
      result.retryable === true;

    if (redisSuccess || redisFetchFail) {
      pdpCache.set(key, { ts: now, data: result });
      const ttl = redisFetchFail ? PDP_FETCH_FAIL_CACHE_SEC : PDP_CACHE_TTL_SEC;
      await redisSetPdpCache(pdpUrl, cacheSlug, {
        ok: result.ok,
        reason: result.reason,
        method: result.method,
        pdpTentative: !!result.pdpTentative,
        retryable: !!result.retryable,
        ms: result.ms ?? 0,
        ts: now,
      }).catch(() => {});
    }

    opsJsonLog('pdp_result', {
      ok: !!result.ok,
      reason: result.reason,
      retryable: !!result.retryable,
      url: String(pdpUrl || '').slice(0, 120),
      kind: 'generic_struct',
    });
    optionallyLogPdpDecision({ canonicalUrl: pdpUrl, rawCm: cacheSlug, result }).catch(() => {});
    return result;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * @param {object[]} items
 * @param {string} rawCm
 * @param {{ concurrency?: number, maxItems?: number }} [opts]
 */
export async function filterItemsByPdpShoeStock(items, rawCm, opts = {}) {
  const concurrency = Math.max(1, Math.min(opts.concurrency || 4, 8));
  const maxItems = Math.max(1, opts.maxItems || 16);
  const list = items.slice(0, maxItems);

  const results = [];
  for (let i = 0; i < list.length; i += concurrency) {
    const chunk = list.slice(i, i + concurrency);
    const part = await Promise.all(
      chunk.map(async (item) => {
        const v = await verifyShoeSizeOnPdp(item, rawCm);
        return { item, v };
      })
    );
    results.push(...part);
  }

  const kept = [];
  const log = [];
  for (const { item, v } of results) {
    log.push({
      sourceId: item.sourceId,
      itemId: item.itemId,
      ok: v.ok,
      reason: v.reason,
      ms: v.ms,
      tentative: !!v.pdpTentative,
    });
    const strictStructural =
      v.ok === true &&
      !v.pdpTentative &&
      String(v.reason || '') === 'dom_structural';
    if (strictStructural) {
      kept.push({
        ...item,
        available: true,
        pdpSizeVerified: true,
        pdpSizeTentative: false,
        pdpSizeCheck: {
          ok: true,
          reason: v.reason,
          ms: v.ms,
          tentative: false,
          scanned: true,
          strictConfirmed: true,
        },
      });
    }
  }

  const dropped = results.length - kept.length;
  return { kept, dropped, log };
}

/**
 * @param {object[]} pool
 * @param {string} rawCm
 * @param {{ prePdpScanIndex?: number, excludeKeys?: Set<string>, excludeSellerModelKeys?: Set<string>, targetCount?: number, maxPdpCalls?: number }} [opts]
 */
export async function collectPdpShoeVerifies(pool, rawCm, opts = {}) {
  const prePdpScanIndex = Math.max(0, Math.floor(opts.prePdpScanIndex != null ? Number(opts.prePdpScanIndex) : 0));
  const excludeKeys = opts.excludeKeys instanceof Set ? opts.excludeKeys : new Set();
  const excludeSm = opts.excludeSellerModelKeys instanceof Set ? opts.excludeSellerModelKeys : new Set();
  const targetCount = Math.max(1, Math.min(30, Number(opts.targetCount) || 10));
  const maxPdpCalls = Math.max(1, Math.min(120, Number(opts.maxPdpCalls) || 40));

  const items = [];
  const log = [];
  const usedSm = new Set(excludeSm);
  let pdpCalls = 0;
  let i = prePdpScanIndex;

  for (; pool && i < pool.length; i++) {
    if (items.length >= targetCount) break;
    const item = pool[i];
    const key = itemCanonicalKey(item);
    if (excludeKeys.has(key)) continue;

    const sm = sellerModelDedupeKey(item);
    if (usedSm.has(sm)) continue;

    if (pdpCalls >= maxPdpCalls) break;

    pdpCalls++;
    const v = await verifyShoeSizeOnPdp(item, rawCm);
    log.push({
      sourceId: item.sourceId,
      itemId: item.itemId,
      ok: v.ok,
      reason: v.reason,
      ms: v.ms,
    });
    const strictStructural =
      v.ok === true &&
      !v.pdpTentative &&
      String(v.reason || '') === 'dom_structural';
    if (strictStructural) {
      usedSm.add(sm);
      items.push({
        ...item,
        available: true,
        pdpSizeVerified: true,
        pdpSizeTentative: false,
        pdpSizeCheck: {
          ok: true,
          reason: v.reason,
          ms: v.ms,
          tentative: false,
          strictConfirmed: true,
        },
        dedupeSellerModel: sm,
        itemKey: key,
      });
      if (items.length >= targetCount) {
        i++;
        break;
      }
    }
  }

  const hitPoolEnd = !pool || i >= (pool.length || 0);
  return {
    items,
    nextPrePdpScanIndex: i,
    hitPoolEnd,
    log,
    pdpCalls,
  };
}
