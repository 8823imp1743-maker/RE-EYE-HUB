/**
 * 横断在庫バリデーター v7 — 全カテゴリ汎用化（靴・鞄・服・雑貨）
 *
 * ── V5 の欠陥（自白）────────────────────────────────────────────────────────
 *   1. 「not_found に -1 ペナルティ」が誤り。
 *      楽天・Yahoo にない = 品切れ、ではない。
 *      Nike.com や ABC-MART にある在庫を楽天が知らないだけ。
 *      → not_found は 0（中立）に修正。
 *
 *   2. 検索軸が楽天・Yahoo の2サイトのみ。
 *      Google が見つける Nike.com / atmos 等を全く見ていなかった。
 *      → Google Custom Search API を第3軸として追加。
 *
 * ── 3軸クロスチェック（v6）─────────────────────────────────────────────────
 *   軸1: Yahoo!ショッピングAPI     (YAHOO_APP_ID — 既存)
 *   軸2: 楽天市場 全体検索          (RAKUTEN_APP_ID — 既存)
 *   軸3: Google Custom Search API  (GOOGLE_CSE_KEY + GOOGLE_CSE_CX — 無料100件/日)
 *        ↑ Nike.com / ABC-MART / atmos など全サイトをカバー
 *
 * ── スコアリング（v6）──────────────────────────────────────────────────────
 *   サイズ明示・在庫あり:
 *     Yahoo  +3 / 楽天全体  +2 / Google +4（信頼ドメイン優先）
 *   サイズ明示・全件品切れ:
 *     Yahoo  -3 / 楽天全体  -2 / Google -3
 *   型番あり・サイズ不明（各サイズ展開）:
 *     全軸    0（中立・証拠なし）
 *   型番なし・not_found:
 *     全軸    0（中立。「ここにない」≠「どこにもない」）← V5 修正点
 *   APIエラー:
 *     全軸    0（自社障害でブロックしない）
 *
 *   PASS:  スコア >= 2  （少なくとも1軸がサイズ込み在庫を確認）
 *   BLOCK: スコア <= -2 （少なくとも1軸がサイズ品切れを確認）
 *   BLOCK: -1 <= スコア <= 1（判定不能 → 安全側）
 *
 * ── 型番なし商品 ─────────────────────────────────────────────────────────
 *   横断検証をスキップして通過（他フィルターに任せる）
 *
 * ── 費用 ─────────────────────────────────────────────────────────────────
 *   追加費用ゼロ（Google CSE 無料100件/日で監視アプリには十分）
 *   Google CSE 未設定時は軸1・2のみで動作（後方互換）
 */

const YAHOO_API_BASE   = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch';
const RAKUTEN_API_BASE = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';
const APP_ORIGIN       = 'https://re-eye-hub.web.app';
const CROSS_TIMEOUT_MS = 6000;

// ── 型番パターン ──────────────────────────────────────────────────────────────
// Nike/Under Armour など（ハイフンあり）: CW2288-111, FJ4146-106, HV4403-001
const MODEL_HYPHEN_RE = /\b([A-Z]{2,4}[0-9]{3,5}-[0-9]{2,4})\b/g;
// Adidas（ハイフンなし）:
//   GW6171 → 2文字英字 + 4桁数字
//   B75807 → 1文字英字 + 5〜6桁数字
//   CQ2093 → 2文字英字 + 4桁数字
// (?!-[0-9]) = ハイフン付きコード（CW2288-111等）の前半部分は除外
const MODEL_PLAIN_RE = /\b([A-Z]{2}[0-9]{4}|[A-Z][0-9]{5,6})(?!-[0-9])\b/g;

export function extractModelNumbers(title) {
  if (!title) return [];
  const t = title.toUpperCase();
  const hyphenMatches = [...t.matchAll(MODEL_HYPHEN_RE)].map(m => m[1]);
  const plainMatches  = [...t.matchAll(MODEL_PLAIN_RE)].map(m => m[1]);
  return [...new Set([...hyphenMatches, ...plainMatches])];
}

// ─────────────────────────────────────────────────────────────────────────────
//  汎用サイズ抽出（靴 / 服 / 数値サイズ）
//  キーワード文字列から「何サイズを探しているか」を解釈する。
// ─────────────────────────────────────────────────────────────────────────────

/** 靴 cm 単一明示以外は fail-close（約・レンジ・曖昧・US/EU） */
const KEYWORD_AMBIGUO_SHOE = new RegExp(
  [
    '約',
    '前後',
    'くらい',
    '位',
    '程度',
    '場合があります',
    '場合も',
    '\\bapprox',
    'だいたい',
    'サイズにより',
    '多少',
    '\\bEU\\b',
    '\\bUK\\s*\\d',
    '\\bUS\\b',
    'u\\.\\s*s\\.\\s*\\.?\\s*\\d',
  ].join('|'),
  'iu'
);

/** レンジ表記があるキーワードは靴サイズ確定しない */
const KEYWORD_SHOE_CM_RANGE_FORBIDDEN =
  /\d{2}(?:\.\d)?\s*(?:㎝|cm)\s*(?:-|～|〜|∼|[\u2013\u2014]|to)\s*\d{2}(?:\.\d)?\s*(?:㎝|cm)?|\d{2}\s*-\s*\d{2}\s*(?:㎝|cm)/iu;

/** 複数離散 cm が列挙（例 : 26 / 26.5 cm）がある場合は単一とはみなさない */
function keywordHasAmbiguousMultipleNumericCm(shoeKw) {
  const matches = [...String(shoeKw).matchAll(/(\d{2}(?:\.\d)?)\s*(?:㎝|\bcm\b)/gi)];
  const uniq = new Set(matches.map((m) => Math.round(parseFloat(m[1]) * 10) / 10));
  return uniq.size > 1;
}

/**
 * キーワードからサイズ情報を抽出する。
 * @param {string} keyword
 * @returns {{ type: 'shoe'|'clothing', raw: string }|null}
 *   type 'shoe'     : 26.5cm → raw "26.5"（単一・非レンジ・**cm 字面のみ**）
 *   type 'clothing' : S/M/L/XL のみ（XS・XXL・フリーサイズ曖昧は null）
 */
export function extractSizeFromKeyword(keyword) {
  if (!keyword) return null;

  // ── 靴: (\d{2}(?:\.\d)?)\s*(cm|㎝) のみ（子10–25／大人14–35 を 10〜35 で受理）
  const shoeCand = keyword.match(/(?:^|[^\d.])(\d{2}(?:\.\d)?)\s*(?:cm|㎝)(?![\d.a-z/])/i);
  if (shoeCand && shoeCand[1]) {
    if (KEYWORD_AMBIGUO_SHOE.test(keyword)) return null;
    if (KEYWORD_SHOE_CM_RANGE_FORBIDDEN.test(keyword)) return null;
    if (keywordHasAmbiguousMultipleNumericCm(keyword)) return null;
    const n = parseFloat(shoeCand[1]);
    if (!Number.isFinite(n)) return null;
    if (n < 10 || n > 35) return null;
    const canon = Math.round(n * 10) / 10;
    const canonical =
      canon % 1 === 0 ? String(Math.trunc(canon)) : canon.toFixed(1).replace(/\.?0+$/, '');
    return { type: 'shoe', raw: canonical };
  }

  /** 監視 PDP 許可 は S/M/L/XL のみ。XS・XXL・フリーサイズ類はサイズ未定義扱い */
  const KW_FREE_SZ_AMBIG =
    /フリ(?:ー)?サイズ|FREE(?:\s*SIZE)?|\bONESIZE\b|\bワンサイズ\b|\bユニサイズ\b|均一\s*(?:サイズ)?/iu;
  if (KW_FREE_SZ_AMBIG.test(keyword)) return null;

  const CLOTHING_ALLOW = ['XL', 'L', 'M', 'S'];
  for (const size of CLOTHING_ALLOW) {
    if (
      new RegExp(`(?:^|[\\s　・/（(【「])(${size})(?=[\\s　・/）)】」]|$|サイズ)`, 'i').test(keyword)
    ) {
      return { type: 'clothing', raw: size };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  サイズ密着フィルタリング（全カテゴリ対応）
// ─────────────────────────────────────────────────────────────────────────────

// 靴専用：US 推測・並記とも禁止。**本文に単独 cm/mm** のみ許可。
function hasSizeInTitle(title, sizeCmStr) {
  if (!sizeCmStr) return false;
  const tWide = String(title || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!tWide) return false;
  const escNum = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const raw = escNum(sizeCmStr);
  const cm = parseFloat(sizeCmStr);
  if (!Number.isFinite(cm)) return false;

  /** 「約」「前後」の近傍にサイズが付くときは単一サイズとはみなさない */
  if (/(約|およそ|前後|くらい|程度)\s*\d{2}(?:\.\d)?\s*(?:㎝|\bcm\b|\bmm\b)?/iu.test(tWide))
    return false;

  /** レンジ行（一覧に広告が混じるときの誤検出防止） */
  if (/\d{2}(?:\.\d)?\s*(?:㎝|\bcm\b)\s*[-〜~\u2013\u2014]/.test(tWide)) return false;

  const boundaryTok = `(?<![0-9.])${raw}(?![0-9.])`;
  if (new RegExp(`${boundaryTok}\\s*(?:㎝|\\bcm\\b)`, 'iu').test(tWide)) return true;

  const mmRounded = Math.round(cm * 10);
  if (Number.isInteger(mmRounded) && (cm * 10) % 1 === 0)
    return new RegExp(`(?<![0-9])${mmRounded}(?![0-9])\\s*mm`, 'iu').test(tWide);

  return false;
}

/**
 * 汎用サイズ一致チェック（靴 / 服 / 数値を統一処理）。
 * @param {string} title
 * @param {{ type: string, raw: string }|null} sizeInfo
 * @returns {boolean}
 */
/**
 * 靴／服／数値サイズがテキスト（商品名・説明文など）に現れるか。
 * SERP ではタイトルだけでなく Yahoo の description / 楽天の itemCaption 等も渡す。
 */
export function hasSizeInTitleUniversal(title, sizeInfo) {
  // fail-close: サイズ不明のとき証明不能 → 要件のある SERP では明示キーワードを要求
  if (!sizeInfo || !sizeInfo.type) return false;

  if (sizeInfo.type === 'shoe') {
    return hasSizeInTitle(title, sizeInfo.raw);
  }

  if (sizeInfo.type === 'clothing') {
    const v = String(sizeInfo.raw || '').toUpperCase();
    return new RegExp(`(?:^|[\\s　])${v}(?=[\\s　]|$|サイズ)`, 'i').test(title || '');
  }

  if (sizeInfo.type === 'numeric') {
    return false;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  軸1: Yahoo!ショッピング
// ─────────────────────────────────────────────────────────────────────────────

async function checkOnYahoo(modelNumber, sizeInfo) {
  if (!process.env.YAHOO_APP_ID) return 'error';
  try {
    const sizeStr = sizeInfo?.type === 'shoe' ? `${sizeInfo.raw}cm` : (sizeInfo?.raw ?? null);
    const query   = sizeStr ? `${modelNumber} ${sizeStr}` : modelNumber;
    const params  = new URLSearchParams({
      appid: process.env.YAHOO_APP_ID, query, results: '20', condition: 'new', sort: '+price',
    });
    const res = await Promise.race([
      fetch(`${YAHOO_API_BASE}?${params}`, { headers: { Accept: 'application/json' } }),
      new Promise((_, r) => setTimeout(() => r(new Error('yahoo-timeout')), CROSS_TIMEOUT_MS)),
    ]);
    if (!res.ok) return 'error';
    const json = await res.json();

    const modelHits = (json.hits || []).filter(h =>
      (h.name || '').toUpperCase().includes(modelNumber.toUpperCase())
    );
    if (modelHits.length === 0) { return 'not_found'; }

    if (sizeInfo) {
      const sizeHits = modelHits.filter(h => hasSizeInTitleUniversal(h.name, sizeInfo));
      if (sizeHits.length === 0) { return 'model_found_no_size'; }
      return sizeHits.some(h => h.inStock === true) ? 'size_confirmed_in_stock' : 'size_confirmed_out';
    }
    return modelHits.some(h => h.inStock === true) ? 'size_confirmed_in_stock' : 'size_confirmed_out';
  } catch(e) {
    console.warn(`[cross-v7/yahoo] 例外:`, e.message);
    return 'error';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  軸2: 楽天市場 全体検索
// ─────────────────────────────────────────────────────────────────────────────

async function checkOnRakutenMarket(modelNumber, sizeInfo) {
  const accessKey = (process.env.RAKUTEN_ACCESS_KEY || '').trim();
  if (!process.env.RAKUTEN_APP_ID || !accessKey) return 'error';
  try {
    const sizeStr = sizeInfo?.type === 'shoe' ? sizeInfo.raw : (sizeInfo?.raw ?? null);
    const keyword = sizeStr ? `${modelNumber} ${sizeStr}` : modelNumber;
    const appId   = (process.env.RAKUTEN_APP_ID || '').replace(/-/g, '');
    const params  = new URLSearchParams({
      applicationId: appId,
      accessKey,
      keyword,
      hits: '20',
      sort: '-updateTimestamp',
    });
    const res = await Promise.race([
      fetch(`${RAKUTEN_API_BASE}?${params}`, {
        headers: {
          Accept: 'application/json', Referer: APP_ORIGIN + '/', Origin: APP_ORIGIN,
        },
      }),
      new Promise((_, r) => setTimeout(() => r(new Error('rakuten-timeout')), CROSS_TIMEOUT_MS)),
    ]);
    if (!res.ok) return 'error';
    const json = await res.json();

    const modelItems = (json.Items || [])
      .map(({ Item }) => Item)
      .filter(i => (i.itemName || '').toUpperCase().includes(modelNumber.toUpperCase()));
    if (modelItems.length === 0) { return 'not_found'; }

    if (sizeInfo) {
      const sizeItems = modelItems.filter(i => hasSizeInTitleUniversal(i.itemName, sizeInfo));
      if (sizeItems.length === 0) { return 'model_found_no_size'; }
      return sizeItems.some(i => i.availability === 1) ? 'size_confirmed_in_stock' : 'size_confirmed_out';
    }
    return modelItems.some(i => i.availability === 1) ? 'size_confirmed_in_stock' : 'size_confirmed_out';
  } catch(e) {
    console.warn(`[cross-v7/rakuten] 例外:`, e.message);
    return 'error';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  スコアリング（v6）
//  ── 修正点: not_found は 0（ペナルティなし）────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const YAHOO_SCORE = {
  size_confirmed_in_stock:  3,
  size_confirmed_out:      -3,
  model_found_no_size:      0,
  not_found:                0,   // ← V5の-1を0に修正。「Yahoo にない」≠「品切れ」
  error:                    0,
};

const RAKUTEN_SCORE = {
  size_confirmed_in_stock:  2,
  size_confirmed_out:      -2,
  model_found_no_size:      0,
  not_found:                0,   // ← V5の-1を0に修正
  error:                    0,
};

// ─────────────────────────────────────────────────────────────────────────────
//  型番なし: キーワード全文で Yahoo + 楽天（Google はコスト削減のため未使用）
// ─────────────────────────────────────────────────────────────────────────────

async function checkOnYahooKeyword(keyword, sizeInfo) {
  if (!process.env.YAHOO_APP_ID || !keyword) return 'error';
  try {
    const query = keyword.trim();
    const params = new URLSearchParams({
      appid: process.env.YAHOO_APP_ID, query, results: '20', condition: 'new', sort: '+price',
    });
    const res = await Promise.race([
      fetch(`${YAHOO_API_BASE}?${params}`, { headers: { Accept: 'application/json' } }),
      new Promise((_, r) => setTimeout(() => r(new Error('yahoo-timeout')), CROSS_TIMEOUT_MS)),
    ]);
    if (!res.ok) return 'error';
    const json = await res.json();
    const hits = json.hits || [];
    if (hits.length === 0) return 'not_found';
    let pool = hits;
    if (sizeInfo) {
      pool = hits.filter(h => hasSizeInTitleUniversal(h.name, sizeInfo));
      if (pool.length === 0) return 'model_found_no_size';
    }
    return pool.some(h => h.inStock === true) ? 'size_confirmed_in_stock' : 'size_confirmed_out';
  } catch(e) {
    console.warn(`[cross-v7/yahoo-kw] 例外:`, e.message);
    return 'error';
  }
}

async function checkOnRakutenKeyword(keyword, sizeInfo) {
  const accessKey = (process.env.RAKUTEN_ACCESS_KEY || '').trim();
  if (!process.env.RAKUTEN_APP_ID || !accessKey || !keyword) return 'error';
  try {
    const kw = keyword.trim();
    const appId = (process.env.RAKUTEN_APP_ID || '').replace(/-/g, '');
    const params = new URLSearchParams({
      applicationId: appId,
      accessKey,
      keyword: kw,
      hits: '20',
      sort: '-updateTimestamp',
    });
    const res = await Promise.race([
      fetch(`${RAKUTEN_API_BASE}?${params}`, {
        headers: {
          Accept: 'application/json', Referer: APP_ORIGIN + '/', Origin: APP_ORIGIN,
        },
      }),
      new Promise((_, r) => setTimeout(() => r(new Error('rakuten-timeout')), CROSS_TIMEOUT_MS)),
    ]);
    if (!res.ok) return 'error';
    const json = await res.json();
    const items = (json.Items || []).map(({ Item }) => Item);
    if (items.length === 0) return 'not_found';
    let pool = items;
    if (sizeInfo) {
      pool = items.filter(i => hasSizeInTitleUniversal(i.itemName, sizeInfo));
      if (pool.length === 0) return 'model_found_no_size';
    }
    return pool.some(i => i.availability === 1) ? 'size_confirmed_in_stock' : 'size_confirmed_out';
  } catch(e) {
    console.warn(`[cross-v7/rakuten-kw] 例外:`, e.message);
    return 'error';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  メイン: 横断在庫バリデーション（楽天・Yahoo のみ）
// ─────────────────────────────────────────────────────────────────────────────

export async function crossValidateStock(item, keyword) {
  const models   = extractModelNumbers(item.title || '');
  const sizeInfo = extractSizeFromKeyword(keyword);
  const fmt      = v => (v >= 0 ? `+${v}` : `${v}`);

  if (models.length === 0) {
    console.log(
      `[cross-v7] 型番なし → Yahoo+楽天キーワード検索:` +
      ` keyword="${(keyword||'').slice(0,40)}"` +
      ` size=${sizeInfo ? `${sizeInfo.type}:${sizeInfo.raw}` : 'なし'}`
    );
    const [yahooResult, rakutenResult] = await Promise.all([
      checkOnYahooKeyword(keyword, sizeInfo),
      checkOnRakutenKeyword(keyword, sizeInfo),
    ]);
    const yScore = YAHOO_SCORE[yahooResult] ?? 0;
    const rScore = RAKUTEN_SCORE[rakutenResult] ?? 0;
    const score  = yScore + rScore;
    const reason = `[型番なし] Yahoo:${yahooResult}(${fmt(yScore)}) 楽天:${rakutenResult}(${fmt(rScore)}) 計${fmt(score)}`;
    const pass = score >= 2;
    if (pass) console.log(`[cross-v7] 【PASS(型番なし)】 ${reason}`);
    else console.log(`[cross-v7] 【BLOCK(型番なし)】${reason}`);
    return { pass, score, reason };
  }

  const mainModel = models[0];
  const sizeLabel = sizeInfo ? `${sizeInfo.raw}(${sizeInfo.type})` : 'なし';
  console.log(`[cross-v7] 開始: model="${mainModel}" size="${sizeLabel}"`);

  const [yahooResult, rakutenResult] = await Promise.all([
    checkOnYahoo(mainModel, sizeInfo),
    checkOnRakutenMarket(mainModel, sizeInfo),
  ]);

  const yScore = YAHOO_SCORE[yahooResult]    ?? 0;
  const rScore = RAKUTEN_SCORE[rakutenResult] ?? 0;
  const score  = yScore + rScore;

  const reason = [
    `[${mainModel}${sizeInfo ? ` ${sizeInfo.raw}` : ''}]`,
    `Yahoo:${yahooResult}(${fmt(yScore)})`,
    `楽天全体:${rakutenResult}(${fmt(rScore)})`,
    `スコア${fmt(score)}`,
  ].join(' ');

  if (score >= 2) {
    console.log(`[cross-v7] 【PASS】 ${reason}`);
    return { pass: true, score, reason };
  }
  console.log(`[cross-v7] 【BLOCK】${reason}`);
  return { pass: false, score, reason };
}
