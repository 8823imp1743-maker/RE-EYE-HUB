/**
 * PDP（商品詳細）HTML を取得し、ユーザーの靴 cm が在庫として選べるか先回り判定する。
 * 一覧 API にサイズが載らない前提で、URL 先の在庫表・バリエーションを解析する。
 *
 * 厳格方針のうえで救済1本: fetch 失敗でも URL にサイズが埋まっていれば通す（Yahoo 系）
 * 楽天: script/JSON 内の cm（本文 DOM に出ないケース向け）を生 HTML から別判定
 * その他: DOM＋厳格トークン（近傍在庫ありは精査済みの経路のみ）
 *
 * 利用者のターゲット（靴 cm 等）・地域は **search 側**で Redis(settings) から解決し、
 * 本モジュールには **当該リクエストの rawCm 文字列** だけ渡る（値は常に user-settings 由来; ここにグローバルな固定 cm は無い）。都道府県は PDP 在庫判定には使わない（将来: 価格・送料）。
 *
 * 実行場所: **Vercel 等の Node**（JSDOM + fetch）。
 * スマホの CPU で動いているのではない — 「HTML を取得できるのは CORS 回避のためサーバ」、負荷は
 * リクエストを細かく分け（フロントの sequentialPdp 等）**積分サーバ時間**を小さくする、という意味で
 * 設計上「利用者の操作リズムに分散」する。timeoutMs は 1 本の PDP で serverless 上限（例 10s）内に収める。
 * 順次 1 件モードで search から **1 回当たり 1 回**しか呼ばれない想定（Vercel 無料枠向け YouTube 型）。
 */

import { JSDOM } from 'jsdom';
import { itemCanonicalKey, sellerModelDedupeKey } from './stock-dedupe.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const NEG_STOCK =
  /在庫なし|品切れ|売り切れ|在庫がありません|購入できません|入荷待ち|お取り寄せ|取り寄せ|お取り寄せ商品|申し訳ございません/iu;
/** 日本 EC: 残りわずか / 注文リード文 / カート＝購入可能のシグナル */
const POS_STOCK =
  /残り[わ少]|在庫あり|在庫がございます|カートに入れ|かごに追加|ショッピングカート|購入可能|即日|翌日|あすつく|在庫あります|お取り扱い|までの注文|最短.*届|本日.*届|12:\d{2}.*注文/iu;

/**
 * @param {string} url
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<string|null>}
 */
export async function fetchPdpHtml(url, timeoutMs = 8000) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) return null;
    const txt = await res.text();
    return typeof txt === 'string' && txt.length > 500 ? txt : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 商品 URL だけでサイズが固定されている店（Yahoo!等: -265.html=26.5 相当）
 * @param {string} [url]
 * @param {string} rawCm "26.5"
 */
function urlImpliesThisShoeSize(url, rawCm) {
  if (!url || !rawCm) return false;
  const n = parseFloat(String(rawCm).replace(/cm$/i, '').trim());
  if (!Number.isFinite(n) || n < 10 || n > 40) return false;
  const dec = Math.round(n * 10) / 10;
  const code3 = String(Math.round(dec * 10));
  const u = String(url);
  if (new RegExp(`[-_/]${code3}(?=[^0-9]|$)`, 'i').test(u)) return true;
  if (u.includes(`size=${code3}`) || u.includes(`sz=${code3}`)) return true;
  return false;
}

function isRakutenPdpUrl(url) {
  return /rakuten\.co\.jp/i.test(String(url || ''));
}

/**
 * 楽天: サイズが JSON/script にのみ現れ、body 本文が薄いケース向け
 * @param {string} html
 * @param {string} rawCm
 */
function checkRakutenSizeInScriptPayload(html, rawCm) {
  if (!html || !rawCm) return false;
  const safe = String(rawCm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sizeInPayload =
    new RegExp(`["']${safe}["']`, 'i').test(html) || new RegExp(`[,:]\\s*${safe}\\s*[,\\]}]`, 'i').test(html);
  if (!sizeInPayload) return false;
  const afterSize = new RegExp(
    `${safe}[^<]{0,300}(在庫あり|残り[わ少]|カート|かご|購入|cart|instock|stock|shopcart)`,
    'i'
  ).test(html);
  const beforeChunk = new RegExp(`(在庫あり|残り[わ少]|カート|かご|購入|カートに入).{0,300}${safe}`, 'i').test(
    html
  );
  return afterSize || beforeChunk;
}

/**
 * 行単位で cm の在庫スコアを付ける（-1=在庫なし系, 1=在庫あり系, 0=不明）
 * @param {string} line
 * @param {string} rawCm  "26.5" など
 */
function lineContainsTargetShoeSize(line, rawCm) {
  const t = String(line);
  const safe = String(rawCm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^\\s*${safe}\\s*(?:cm|ｃｍ|CM)?\\s*$`, 'i').test(t.trim())) return true;
  return new RegExp(
    `(?:^|[^0-9.])${safe}(?:\\s*(?:cm|ｃｍ|CM))?(?:$|\\D|[^0-9.])`,
    'i'
  ).test(t);
}

function scoreLineForCm(line, rawCm) {
  if (!lineContainsTargetShoeSize(line, rawCm)) return 0;
  const neg = NEG_STOCK.test(line);
  const pos = POS_STOCK.test(line);
  if (neg && !pos) return -1;
  if (pos && !neg) return 1;
  return 0;
}

/**
 * 圧縮本文のうち、対象 cm 付近（同一断片）に「買い可能」文脈（Rakuten Fashion 等）
 */
function hasPositiveNearShoeSizeInText(flat, rawCm) {
  const safe = String(rawCm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idx = flat.search(new RegExp(safe, 'i'));
  if (idx < 0) return false;
  const chunk = flat.slice(idx, Math.min(flat.length, idx + 200));
  if (NEG_STOCK.test(chunk) && !POS_STOCK.test(chunk)) return false;
  return /残り[わ少]|在庫あり|かごに追加|カートに入/.test(chunk);
}

/**
 * @param {string} html
 * @param {string} rawCm
 * @param {string} [pdpUrl] 検索 API の item.url（1 URL=1 サイズの店舗用）
 * @returns {{ ok: boolean, reason: string, method: string }}
 */
export function analyzePdpHtmlForShoeCm(html, rawCm, pdpUrl = '') {
  if (!html || !rawCm) return { ok: false, reason: 'no_input', method: 'none' };
  if (String(html).length < 500) {
    return { ok: false, reason: 'pdp_fetch_fail', method: 'parse' };
  }

  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const titleT = (doc.querySelector('title') && doc.querySelector('title').textContent) || '';
    const titleHead = (titleT || '').trim().slice(0, 200);
    if (/(^|\s)404(\s|[-|]|$)|お探しの商品は見つかりません|商品が存在しません|指定された商品は/iu.test(titleHead)) {
      return { ok: false, reason: 'pdp_page_error', method: 'none' };
    }

    const rawEsc = String(rawCm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (pdpUrl && isRakutenPdpUrl(pdpUrl) && checkRakutenSizeInScriptPayload(html, rawCm)) {
      return { ok: true, reason: 'pdp_rakuten_script_match', method: 'rakuten_script' };
    }

    const lines = [];

    const pushText = (s) => {
      if (s && typeof s === 'string') {
        const t = s.replace(/\s+/g, ' ').trim();
        if (t.length > 2 && t.length < 500) lines.push(t);
      }
    };

    doc.querySelectorAll('option, label, li, tr, td, th, button, [role="option"], span, p, div').forEach((el) => {
      const tx = el.textContent;
      if (tx) pushText(tx);
    });

    const bodyText = (doc.body && doc.body.textContent) || '';
    bodyText.split(/\n|\r/).forEach((ln) => pushText(ln));

    let bestNeg = false;
    let bestPos = false;

    doc.querySelectorAll('option').forEach((opt) => {
      const tx = (opt.textContent || '').replace(/\s+/g, ' ');
      const val = String(opt.value || '');
      if (lineContainsTargetShoeSize(tx, rawCm) || (val && lineContainsTargetShoeSize(val, rawCm))) {
        if (!opt.disabled) bestPos = true;
        else bestNeg = true;
      }
      if (!new RegExp(rawEsc, 'i').test(tx) && !(val && new RegExp(rawEsc, 'i').test(val))) return;
      if (opt.disabled) bestNeg = true;
      if (scoreLineForCm(tx, rawCm) === 1) bestPos = true;
      if (scoreLineForCm(tx, rawCm) === -1) bestNeg = true;
    });

    for (const line of lines) {
      const sc = scoreLineForCm(line, rawCm);
      if (sc === -1) bestNeg = true;
      if (sc === 1) bestPos = true;
    }

    const flat = bodyText.replace(/\s+/g, ' ').slice(0, 400_000);
    const near = new RegExp(`(.{0,60})${rawEsc}\\s*(?:cm|ｃｍ)?(.{0,120})`, 'i');
    const m = flat.match(near);
    if (m) {
      const chunk = (m[1] || '') + (m[2] || '');
      if (NEG_STOCK.test(chunk) && !POS_STOCK.test(chunk)) bestNeg = true;
      if (POS_STOCK.test(chunk) && !NEG_STOCK.test(chunk)) bestPos = true;
    }

    if (pdpUrl && urlImpliesThisShoeSize(pdpUrl, rawCm) && POS_STOCK.test(flat)) {
      return { ok: true, reason: 'pdp_yahoo_sku_confirmed', method: 'url_sku' };
    }

    const sizeTokenRe = new RegExp(`(^|[^\\d])${rawEsc}([^\\d]|$)`, 'i');
    if (!sizeTokenRe.test(flat) && !sizeTokenRe.test((titleT || '').trim())) {
      return { ok: false, reason: 'pdp_size_not_mentioned', method: 'none' };
    }

    if (bestPos && !bestNeg) {
      return { ok: true, reason: 'pdp_positive', method: 'dom+regex' };
    }
    if (bestNeg && !bestPos) {
      return { ok: false, reason: 'pdp_listed_out', method: 'dom+regex' };
    }

    if (hasPositiveNearShoeSizeInText(flat, rawCm)) {
      return { ok: true, reason: 'pdp_fashion_proximity', method: 'proximity' };
    }

    return { ok: false, reason: 'pdp_size_out_of_stock', method: 'strict_filter' };
  } catch (e) {
    return { ok: false, reason: 'parse_error:' + (e && e.message), method: 'dom' };
  }
}

/**
 * @param {{ url?: string, sourceId?: string }} item
 * @param {string} rawCm 例 "26.5"
 * @returns {Promise<{ ok: boolean, reason: string, method: string, ms: number }>}
 */
export async function verifyShoeSizeOnPdp(item, rawCm) {
  const t0 = Date.now();
  const url = item && item.url;
  const html = await fetchPdpHtml(url, 9000);
  if (!html) {
    if (url && urlImpliesThisShoeSize(url, rawCm)) {
      const out = {
        ok: true,
        reason: 'pdp_fetch_fail_but_url_match',
        method: 'url_fallback',
        pdpTentative: true,
        ms: Date.now() - t0,
      };
      console.log('[PDP CHECK] fetch 失敗 → URL 埋め込み救済', { url, size: rawCm, result: out });
      return out;
    }
    const out = { ok: false, reason: 'pdp_fetch_fail', method: 'fetch', ms: Date.now() - t0 };
    console.log('[PDP CHECK] fetch 失敗 or 短い HTML', { url, size: rawCm, result: out });
    return out;
  }
  const r = analyzePdpHtmlForShoeCm(html, rawCm, url || '');
  const full = { ...r, ms: Date.now() - t0 };
  console.log('[PDP CHECK]', { url, size: rawCm, result: full });
  return full;
}

/**
 * 並列数を抑えて PDP 検証（Vercel 時間内に収める）
 * @param {object[]} items
 * @param {string} rawCm
 * @param {{ concurrency?: number, maxItems?: number }} [opts]
 * @returns {Promise<{ kept: object[], dropped: number, log: object[] }>}
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
    if (v.ok) {
      kept.push({
        ...item,
        pdpSizeVerified: true,
        pdpSizeTentative: !!v.pdpTentative,
        pdpSizeCheck: { ok: true, reason: v.reason, ms: v.ms, tentative: !!v.pdpTentative },
      });
    }
  }

  const dropped = results.length - kept.length;
  return { kept, dropped, log };
}

/**
 * プール内を先頭から走査し、除外・店舗+品番の重複を飛ばしつつ PDP で在庫確定するまで回す
 * @param {object[]} pool 検索用プール（順序固定）
 * @param {string} rawCm
 * @param {{ prePdpScanIndex?: number, excludeKeys?: Set<string>, excludeSellerModelKeys?: Set<string>, targetCount?: number, maxPdpCalls?: number }} [opts]
 * @returns {Promise<{ items: object[], nextPrePdpScanIndex: number, hitPoolEnd: boolean, log: object[], pdpCalls: number }>}
 */
export async function collectPdpShoeVerifies(pool, rawCm, opts = {}) {
  const prePdpScanIndex = Math.max(0, Math.floor(opts.prePdpScanIndex != null ? Number(opts.prePdpScanIndex) : 0));
  const excludeKeys = opts.excludeKeys instanceof Set ? opts.excludeKeys : new Set();
  const excludeSm = opts.excludeSellerModelKeys instanceof Set ? opts.excludeSellerModelKeys : new Set();
  const targetCount = Math.max(1, Math.min(30, Number(opts.targetCount) || 10));
  const maxPdpCalls = Math.max(1, Math.min(120, Number(opts.maxPdpCalls) || 80));

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
    if (v.ok) {
      usedSm.add(sm);
      items.push({
        ...item,
        pdpSizeVerified: true,
        pdpSizeTentative: !!v.pdpTentative,
        pdpSizeCheck: { ok: true, reason: v.reason, ms: v.ms, tentative: !!v.pdpTentative },
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
