/**
 * サイズ別在庫判定エンジン（最終確定・実戦投入版）
 * Logic Flow: 
 * L1: Deterministic UI (高精度・最速終了)
 * L1.5: JSON Positive-only (SPA対応・40ch Chunk紐付)
 * L2: Proximity Recall (救済策・Strict Reject判定)
 */

import { JSDOM }          from 'jsdom';
import { httpsFetch }     from './http.js';
import { stealthHeaders } from './stealth.js';
import { extractSizeCm }  from './user-size.js';

const PAGE_TIMEOUT_MS = 8000;
const PROXIMITY_CHECK_LIMIT = 25; 
const MAX_DOM_ELEMENTS = 3000; // 走査要素リミッター

const US_TO_CM = {
  4:22.0, 4.5:22.5, 5:23.0, 5.5:23.5, 6:24.0, 6.5:24.5,
  7:25.0, 7.5:25.5, 8:26.0, 8.5:26.5, 9:27.0, 9.5:27.5,
  10:28.0, 10.5:28.5, 11:29.0, 11.5:29.5, 12:30.0, 12.5:30.5,
  13:31.0, 14:32.0,
};

const PURCHASE_SIGNALS = ['カートに入れる', 'かごに入れる', 'add to cart', 'buy now', '注文する', '残りわずか', '在庫あり', '在庫を見る'];
const REJECTION_SIGNALS = ['×', '✕', '✗', '✘', '❌', '売り切れ', '品切れ', '在庫なし', '再入荷', '入荷待ち', 'sold', 'SOLD'];

// [Optimization] 高頻度Runtime用シグナルの小文字化プリコンパイル
const LOWER_PURCHASE_SIGNALS = PURCHASE_SIGNALS.map(s => s.toLowerCase());
const LOWER_REJECTION_SIGNALS = REJECTION_SIGNALS.map(s => s.toLowerCase());

const SOLDOUT_CLASS_RE = /sold.?out|soldout|out.?of.?stock|品切|売り?切|在庫なし|disabled|unavailable/i;
const HIDDEN_CLASS_RE = /\b(hidden|dn|d-none|invisible|visually-hidden)\b/i;

function normalizeSizeCm(text) {
  if (!text) return null;
  const t = text.trim();
  const cmMatch = t.match(/(2[2-9](?:\.\d)?|3[0-2](?:\.\d)?)\s*(?:cm)?/i);
  if (cmMatch) return parseFloat(cmMatch[1]);
  const usM = t.match(/US\s*(\d{1,2}(?:\.\d)?)/i);
  if (usM) return US_TO_CM[parseFloat(usM[1])] ?? null;
  return null;
}

/** 
 * Layer 1: Deterministic UI Scan (高精度・要素制限付)
 */
function checkSizeInUI(doc, targetLabel, isCm) {
  const allElements = doc.querySelectorAll(
    'button, select option, input, [data-size], [data-value], [role="button"], [aria-label], li, label'
  );
  
  let count = 0;
  let foundExplicitReject = false;

  for (const el of allElements) {
    if (++count > MAX_DOM_ELEMENTS) break; // 巨大NodeListによるスタック防止

    // [Memory Safety] textContent事故防止のため一定文字数で制限
    const rawSelfText = (el.textContent || '').slice(0, 120);
    const rawText = [
      rawSelfText,
      el.value,
      el.getAttribute('data-value'),
      el.getAttribute('data-size'),
      el.getAttribute('aria-label')
    ].filter(Boolean).join(' ');

    const elSize = isCm ? normalizeSizeCm(rawText) : rawText.trim().toUpperCase();
    if (elSize === null) continue;

    if (isCm) {
      if (Number(elSize) !== Number(targetLabel)) continue;
    } else {
      if (String(elSize) !== String(targetLabel)) continue;
    }

    // 強化版 Hidden Style / Class Check
    const style = (el.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '');
    
    // [Safety] SVGAnimatedStringなどのObject事故を回避
    const className = typeof el.className === 'string' ? el.className : (el.className?.baseVal || '');

    if (style.includes('display:none') || style.includes('visibility:hidden') || 
        style.includes('opacity:0') || HIDDEN_CLASS_RE.test(className) || 
        el.hidden || el.getAttribute('aria-hidden') === 'true') {
      continue;
    }

    // 物理的無効化判定
    if (el.disabled || el.hasAttribute('disabled')) { foundExplicitReject = true; continue; }
    
    // クラス名・親要素からの売切判定
    const parentCls = [className, el.parentElement?.className || '', el.parentElement?.parentElement?.className || ''].join(' ');
    if (SOLDOUT_CLASS_RE.test(parentCls)) { foundExplicitReject = true; continue; }

    // テキスト排他判定
    const lowerNormalized = rawText.toLowerCase();
    const hasRejectSignal   = LOWER_REJECTION_SIGNALS.some(s => lowerNormalized.includes(s));
    const hasPurchaseSignal = LOWER_PURCHASE_SIGNALS.some(s => lowerNormalized.includes(s));

    if (hasRejectSignal && !hasPurchaseSignal) {
      foundExplicitReject = true; continue;
    }

    return true; // 明確な在庫発見
  }
  return foundExplicitReject ? false : null;
}

/**
 * Layer 1.5: JSON Structured Data Scan (Positive Only)
 */
function checkSizeInStructuredData(doc, targetLabel) {
  const jsonNodes = doc.querySelectorAll('#__NEXT_DATA__, #item-page-app-data, [type="application/ld+json"]');
  const escaped = String(targetLabel).replace('.', '\\.');
  // boundary(境界)Regexによる価格などへの誤爆回避
  const sizeRe = new RegExp(`(?:^|[^0-9])${escaped}(?:\\.0)?(?:cm)?(?:[^0-9]|$)`, 'i');

  for (const node of jsonNodes) {
    const txt = node.textContent;
    if (!txt || !sizeRe.test(txt)) continue;

    // [Crucial Fix] サイズ前後40chのみにスコープを絞り、別サイズのSKU在庫との混線を遮断
    const chunkRe = new RegExp(`.{0,40}${escaped}(?:\\.0)?(?:cm)?.{0,40}`, 'gi');
    const chunks = txt.match(chunkRe);
    if (!chunks) continue;

    for (const chunk of chunks) {
      const hasPositiveStock = /"(?:quantity|inventory|stock)"\s*:\s*[1-9]\d*/i.test(chunk) || 
                               /"available"\s*:\s*true/i.test(chunk) ||
                               /"stock_status"\s*:\s*"instock"/i.test(chunk);
      // 正確性を期すため positive 発見時のみ true を返す。false判定はL1またはL2に任せる
      if (hasPositiveStock) return true;
    }
  }
  return null;
}

/**
 * Main Organic Flow
 */
export async function checkSizeAvailableOnPage(pageUrl, keyword) {
  const targetCm    = extractSizeCm(keyword);
  const targetCloth = keyword.match(/\b(XXS|XS|S|M|L|XL|XXL|2XL|3XL)\b/i)?.[1]?.toUpperCase();
  const isCm        = targetCm !== null;
  const targetLabel = isCm ? targetCm.toFixed(1) : (targetCloth || null);

  if (!targetLabel) return true;

  let html = '';
  try {
    const res = await httpsFetch(pageUrl, { method: 'GET', timeoutMs: PAGE_TIMEOUT_MS, headers: stealthHeaders(keyword) });
    html = res.body || '';
  } catch(e) { return false; }

  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // L1 & L1.5 の決定論的アプローチ（スクリプト除去前に実行）
  const uiResult = checkSizeInUI(doc, targetLabel, isCm);
  if (uiResult !== null) return uiResult;

  const jsonResult = checkSizeInStructuredData(doc, targetLabel);
  if (jsonResult === true) return true;

  // Layer 2: Cleanup for Final Fallback
  doc.querySelectorAll('script, style, noscript, iframe, svg, header, footer').forEach(el => el.remove());
  const bodyText = (doc.body?.textContent || '').replace(/\s+/g, ' ').slice(0, 300000); 
  
  const escapedBase = isCm ? targetLabel.replace('.', '\\.') : targetLabel;
  const looseSizeRe = new RegExp(`(?:^|[^0-9])${escapedBase}(?:\\.0)?\\s*(?:cm|センチ)?(?:$|[^0-9])`, 'gi');

  let match, count = 0;
  while ((match = looseSizeRe.exec(bodyText)) !== null) {
    if (++count > PROXIMITY_CHECK_LIMIT) break;
    const context = bodyText.slice(Math.max(0, match.index - 250), Math.min(bodyText.length, match.index + 250)).toLowerCase();
    
    // Recall救済：購入シグナルがあり、かつ周辺に「一切の拒絶ワードがない」場合のみ許可
    const hasPurchase = LOWER_PURCHASE_SIGNALS.some(s => context.includes(s));
    const hasAnyReject = LOWER_REJECTION_SIGNALS.some(s => context.includes(s));

    if (hasPurchase && !hasAnyReject) {
      console.log(`[SERE-SUCCESS] Proximity救済発動: "${targetLabel}" in context area.`);
      return true;
    }
  }

  // 判定不能時の観測ログ：ここから Rule Mining フェーズへ繋げる
  console.log(`[SERE-REPORT] BLOCKED SIZE:${targetLabel} URL:${pageUrl.slice(0, 50)}...`);
  return false;
}