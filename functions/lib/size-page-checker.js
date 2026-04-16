/**
 * サイズ別在庫ページスクレイパー（超・冷徹モード）
 *
 * 哲学: 「買えるボタンが物理的に存在しないページは、この世に存在しない」
 *
 * 判定は「ネガティブ（悪い言葉を探す）」から
 * 「ポジティブ（買えるボタンが存在するか）」へ完全転換。
 *
 * 安全側のデフォルト:
 *   フェッチ失敗 / パース失敗 / サイズUI未検出 → 全てブロック（false）
 *   監督に「期待外れ」を見せるくらいなら、黙っている方がマシ。
 */

import { JSDOM }          from 'jsdom';
import { httpsFetch }     from './http.js';
import { stealthHeaders } from './stealth.js';
import { extractSizeCm }  from './user-size.js';

const PAGE_TIMEOUT_MS = 8000;

// ── USサイズ → cm 変換テーブル ──────────────────────────────────────────────
const US_TO_CM = {
  4:22.0, 4.5:22.5, 5:23.0, 5.5:23.5, 6:24.0, 6.5:24.5,
  7:25.0, 7.5:25.5, 8:26.0, 8.5:26.5, 9:27.0, 9.5:27.5,
  10:28.0, 10.5:28.5, 11:29.0, 11.5:29.5, 12:30.0, 12.5:30.5,
  13:31.0, 14:32.0,
};

// ── 「買えるボタン」の判定（ポジティブ判定の核心）────────────────────────────
// 【厳格ルール】
//   - ID/name/class でカート専用と特定できるセレクターのみ使用する
//   - 'button[type="submit"]' / 'input[type="submit"]' は使用禁止
//     理由: 楽天の「再入荷をお知らせする」ボタンも submit 型であり、
//           汎用セレクターでは区別できない → 致命的な誤検知の原因
const CART_BUTTON_SELECTORS = [
  // 楽天PC版（ID/name で確実に特定できるもののみ）
  '#addcart',
  'button[name="addcartButton"]',
  'input[name="addcartButton"]',
  // 楽天スマホ版（直接ID狙い撃ち）
  '#rakutenLimitedId_cart',
  '[id*="rakutenLimitedId_cart"]',
  '[id*="addcart"]',
  '[id*="cart_btn"]',
  '[class*="cart-button"]',
  '[class*="addcart"]',
  '[class*="add-to-cart"]',
  // Yahoo!ショッピング
  'button[data-button-type="cart"]',
  '#ys-btn-cart',
  '[class*="ys-btn-cart"]',
  // ※ 'button[type="submit"]' / 'input[type="submit"]' は意図的に除外
  //   （再入荷お知らせフォームと区別不可）
];

// ── ボタンテキストによるカートボタン判定（厳格版）────────────────────────────
// 完全一致または前方一致で判定する（「購入する」の部分一致は禁止）
// 「再入荷をお知らせ」ボタンに含まれる語との混在を防ぐため、
// テキストが再入荷ワードと共存する場合は通過させない
const CART_TEXT_EXACT = [
  'カートに入れる',
  'カートへ入れる',
  'かごに入れる',
  'ショッピングカートに入れる',
  'add to cart',
];

// ── 「在庫なし」の確定シグナル（ページ全体テキストスキャン用）────────────────
// これらがページ全体テキストに含まれる場合、カートボタンの有無に関わらず
// 「在庫なし」を示す強いシグナルとして扱う
const SOLDOUT_TEXT_SIGNALS = [
  '再入荷お知らせ', '再入荷通知', '入荷お知らせ', '入荷通知',
  '再入荷メール', '入荷待ち', 'SOLD OUT', 'Sold Out',
  '只今品切れ', '只今欠品中', '品切れ中', '在庫切れ',
  '売り切れ中', '完売', 'sold out',
];

// ── サイズ要素周囲の拒絶シグナル ────────────────────────────────────────────
const REJECTION_NEAR_SIZE = [
  '×', '✕', '✗', '✘', '❌',
  '売り切れ', '品切れ', '在庫なし', '再入荷', '入荷待ち',
  'sold', 'SOLD', '残り0',
];

const SOLDOUT_CLASS_RE =
  /sold.?out|soldout|out.?of.?stock|品切|売り?切|在庫なし|unavailable|disabled|no.?stock/i;

/** テキストからcmサイズを正規化（US表記・表記ゆれ対応） */
function normalizeSizeCm(text) {
  if (!text) return null;
  const t = text.trim();

  const cm = extractSizeCm(t);
  if (cm !== null) return cm;

  // "260mm" → 26.0
  const mmM = t.match(/(\d{3})\s*mm/i);
  if (mmM) return parseFloat(mmM[1]) / 10;

  // "US8" / "US 8" / "US8.5"
  const usM = t.match(/US\s*(\d{1,2}(?:\.\d)?)/i);
  if (usM) {
    const usSize = parseFloat(usM[1]);
    return US_TO_CM[usSize] ?? null;
  }

  // "26cm(US8)" → cm 部分を優先
  const mixM = t.match(/(\d{2,3}(?:\.\d)?)\s*(?:cm)?\s*\(\s*US\s*\d/i);
  if (mixM) return parseFloat(mixM[1]);

  return null;
}

/** 服サイズの正規化 */
function normalizeClothSize(text) {
  const m = text.trim().match(
    /^(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|フリー|ONE\s*SIZE|FREE)$/i
  );
  return m ? m[1].toUpperCase().replace(/\s+/g, '') : null;
}

// ── 再入荷・品切れを示すボタンテキスト（カートボタンから除外するため）──────
const RESTOCK_BUTTON_TEXT_RE =
  /再入荷|入荷お知らせ|入荷通知|sold.?out|品切|売り?切|在庫なし|入荷待ち/i;

/**
 * ページに「実際に押せるカートボタン」が存在するか判定する。
 *
 * 【欠陥修正 v2】
 *   - button[type="submit"] / input[type="submit"] の汎用セレクターを廃止
 *   - セレクターにマッチした要素のテキストに「再入荷」「品切れ」等が含まれる場合は除外
 *   - テキストフォールバックは完全一致のみ（部分一致で「購入する」を拾う欠陥を修正）
 *
 * @param {Document} doc
 * @param {string}   fullText  HTMLをタグ除去したプレーンテキスト
 * @returns {boolean}
 */
function hasRealCartButton(doc, fullText) {
  // セレクターで直接探す（最優先・最速）
  for (const sel of CART_BUTTON_SELECTORS) {
    try {
      const els = doc.querySelectorAll(sel);
      for (const el of els) {
        // disabled なボタンはカウントしない
        if (el.disabled || el.hasAttribute('disabled')) continue;
        if (el.getAttribute('aria-disabled') === 'true') continue;
        // hidden も除外
        const style = el.getAttribute('style') || '';
        if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) continue;

        // ── 重要: ボタンのテキストが「再入荷・品切れ系」ならカートボタンではない ──
        const btnText = (el.textContent || el.value || '').trim();
        if (RESTOCK_BUTTON_TEXT_RE.test(btnText)) {
          console.log(`[size-checker] 再入荷ボタンをスキップ: "${btnText.slice(0,30)}"`);
          continue;
        }

        console.log(`[size-checker] カートボタン発見: sel="${sel}" text="${btnText.slice(0,30)}"`);
        return true;
      }
    } catch(_) { /* 無効セレクターはスキップ */ }
  }

  // テキストフォールバック（完全一致のみ — 部分一致による誤検知を防ぐ）
  for (const pat of CART_TEXT_EXACT) {
    // fullText は全タグ除去済みなので、pat が独立したテキストとして存在するか確認
    // 「再入荷をお知らせ」等のテキストと同一ページにある場合は信頼しない
    if (fullText.includes(pat)) {
      // カートテキストと売り切れシグナルが同じページにある場合 → JS動的ページの可能性大
      // 売り切れシグナルが優先（安全側）
      const hasSoldOutSignal = SOLDOUT_TEXT_SIGNALS.some(s => fullText.includes(s));
      if (hasSoldOutSignal) {
        console.log(`[size-checker] カートテキスト"${pat}"と売り切れシグナルが共存 → 安全側でブロック`);
        return false;
      }
      console.log(`[size-checker] カートテキスト発見: "${pat}"`);
      return true;
    }
  }

  return false;
}

/**
 * 指定サイズのUI要素を探し、購入可能かを判定する。
 * UI が見つからない → false（安全側）
 *
 * @param {Document} doc
 * @param {number|string} targetLabel  "26.0" または "M" 等
 * @param {boolean} isCm
 * @returns {boolean|null}  true=OK / false=品切れ / null=UI未検出
 */
function checkSizeInUI(doc, targetLabel, isCm) {
  const SELECTORS = [
    'input[type="radio"]', 'input[type="checkbox"]',
    'select option', 'button', 'li', 'label', 'span', 'a', 'div',
  ];

  for (const sel of SELECTORS) {
    const elements = doc.querySelectorAll(sel);
    for (const el of elements) {
      const rawText = [
        el.textContent,
        el.value,
        el.getAttribute('data-value'),
        el.getAttribute('data-size'),
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
      ].filter(Boolean).join(' ');

      let elSize = null;
      if (isCm) {
        elSize = normalizeSizeCm(rawText);
      } else {
        elSize = normalizeClothSize(rawText);
      }

      if (elSize === null || String(elSize) !== String(targetLabel)) continue;

      // 対象サイズ発見 → 購入可能か判定
      if (el.disabled || el.hasAttribute('disabled')) {
        console.log(`[size-checker] disabled: "${rawText.slice(0,30)}"`);
        return false;
      }

      const cls = [
        el.className || '',
        el.parentElement?.className || '',
        el.getAttribute('data-status') || '',
      ].join(' ');
      if (SOLDOUT_CLASS_RE.test(cls)) {
        console.log(`[size-checker] sold-outクラス: "${cls.slice(0,50)}"`);
        return false;
      }

      // 周囲テキストに拒絶ワードがあるか
      const ctx = [
        el.textContent || '',
        el.parentElement?.textContent || '',
        el.parentElement?.parentElement?.textContent || '',
      ].join(' ').slice(0, 400);

      if (REJECTION_NEAR_SIZE.some(s => ctx.includes(s))) {
        console.log(`[size-checker] 拒絶ワード周囲確認: "${ctx.slice(0,60)}"`);
        return false;
      }

      return true; // サイズ見つかり、拒絶なし → 購入可能
    }
  }

  return null; // UI未検出
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * 商品ページ URL をフェッチし、指定サイズが購入可能かを判定する。
 *
 * @param {string} pageUrl   商品ページ URL
 * @param {string} keyword   見守りキーワード（例: "ナイキ エアフォース1 26.0cm"）
 * @returns {Promise<boolean>}  true = 購入可能 / false = 品切れ or 判定不能
 */
export async function checkSizeAvailableOnPage(pageUrl, keyword) {
  const targetCm    = extractSizeCm(keyword);
  const targetCloth = keyword.match(/\b(XXS|XS|S|M|L|XL|XXL|2XL|3XL)\b/i)?.[1]?.toUpperCase();
  const hasSize     = targetCm !== null || !!targetCloth;
  const isCm        = targetCm !== null;
  const targetLabel = isCm ? targetCm.toFixed(1) : (targetCloth || null);

  console.log(`[size-checker] 開始: size="${targetLabel ?? 'なし'}" url="${pageUrl.slice(0,80)}"`);

  // ── フェッチ（失敗 → ブロック）──────────────────────────────────────────
  let html = '';
  try {
    const result = await Promise.race([
      httpsFetch(pageUrl, {
        method:      'GET',
        timeoutMs:   PAGE_TIMEOUT_MS,
        maxRedirects: 3,
        headers:     stealthHeaders(keyword),
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('page-timeout')), PAGE_TIMEOUT_MS)
      ),
    ]);

    if (!result || result.statusCode >= 400) {
      console.warn(`[size-checker] HTTP ${result?.statusCode} → ブロック`);
      return false; // 安全側: ブロック
    }
    html = result.body || '';
  } catch(e) {
    console.warn(`[size-checker] フェッチ失敗 (${e.message}) → ブロック`);
    return false; // 安全側: ブロック
  }

  const fullText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // ── JSDOM パース（失敗 → ブロック）─────────────────────────────────────
  let doc;
  try {
    doc = new JSDOM(html, { runScripts: 'outside-only' }).window.document;
  } catch(e) {
    console.warn(`[size-checker] JSDOM 失敗 → ブロック`);
    return false; // 安全側: ブロック
  }

  // ── Step1 ポジティブ判定: カートボタンが存在しないなら即ブロック ──────────
  // 「買えるボタンが物理的に存在しないページは、この世に存在しない」
  if (!hasRealCartButton(doc, fullText)) {
    // 再入荷シグナルがあればより確実に報告
    const soldOutSignal = SOLDOUT_TEXT_SIGNALS.find(s => fullText.includes(s)) || '';
    console.log(`[size-checker] 【BLOCKED】カートボタン不在${soldOutSignal ? ` (シグナル:"${soldOutSignal}")` : ''}`);
    return false;
  }

  // ── サイズ指定がない場合 → カートあり確認で通過 ──────────────────────────
  if (!hasSize) {
    console.log(`[size-checker] サイズ指定なし + カートあり → 通過`);
    return true;
  }

  // ── Step2 サイズUI走査 ────────────────────────────────────────────────────
  const sizeResult = checkSizeInUI(doc, targetLabel, isCm);

  if (sizeResult === true) {
    console.log(`[size-checker] 【OK】size=${targetLabel} 購入可能確認`);
    return true;
  }

  if (sizeResult === false) {
    console.log(`[size-checker] 【BLOCKED】size=${targetLabel} 品切れ確定`);
    return false;
  }

  // null = サイズUI未検出
  // 【欠陥修正 v2】フォールバックでの true 返却を廃止
  //
  // 旧実装:「ページ上にサイズテキストがあり、拒絶ワードがなければ通過」
  // 問題点:「26.0cmは再入荷をお待ちください」など、
  //         サイズが説明文・メタ情報に登場するだけで通過してしまっていた。
  //
  // 新実装: サイズUI（ラジオボタン・セレクト・ボタン）が特定できなければ
  //         判断不能 → 安全側でブロック。
  //         JSDOM で読めないJS動的ページも同様にブロック。
  console.log(`[size-checker] 【BLOCKED】サイズUI未検出 (size=${targetLabel}) → 判断不能・安全側でブロック`);
  return false;
}
