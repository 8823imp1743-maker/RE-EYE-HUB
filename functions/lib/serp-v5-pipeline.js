/**
 * RE-EYE-HUB v5 FINAL — SERP→軽量ノイズ→LLM→score→**runSerpV5PdpVerify のみ**→dom_structural→**CE（矛盾検知）**。
 * browse / monitor SERP / 公式 PDP の実 HTTP は本モジュールの runSerpV5PdpVerify に一元化（二重実装禁止）。
 */

import { NOISE_KEYWORDS, classifySerpItemsBatch, scoreSerpClassification } from './serp-product-classifier.js';
import {
  collectRequiredSizeInfos,
  buildSerpRuleEntryForKeyword,
} from './serp-item-rule.js';
import { extractSizeFromKeyword, hasSizeInTitleUniversal } from './cross-validator.js';
import {
  validateColorMatchForItem,
  buildSerpPlainTextHaystack,
} from './color-filter.js';
import { matchesProductKeyword } from './keyword-match.js';
import { normalizeBrand } from './brand-normalizer.js';
import {
  PDP_CLOTHING_ALPHAS,
  verifyShoeSizeOnPdp,
  verifyClothingSizeOnPdp,
  verifyGenericMainStructuralBuyOnPdp,
} from './pdp-shoe-stock.js';
import { evaluateContradictionEngine } from './contradiction-engine.js';
import { recordCeRejectionSafe, ceFeedbackUrlHost } from './ce-feedback.js';

export { NOISE_KEYWORDS };

/**
 * OFF→ON・browse 採用の唯一の真値（runSerpV5PdpVerify 戻り値のみを解釈する）。
 * @param {object|null|undefined} pdpv
 */
export function isSerpV5PdpDomStructuralOn(pdpv) {
  return (
    !!pdpv &&
    pdpv.ok === true &&
    !pdpv.pdpTentative &&
    String(pdpv.reason || '') === 'dom_structural'
  );
}

/** vFINAL: PDP dom_structural かつ矛盾検知（CE）が reject でない */
export function isSerpV5FinalStockOn(pdpv, ceOut) {
  return isSerpV5PdpDomStructuralOn(pdpv) && !!ceOut && ceOut.status !== 'reject';
}

/**
 * 公式 URL 等：キーワードから単一 PDP タスク（SERP 分類なし）。
 * @param {{ type: string, raw: string }|null|undefined} kwSizeForPdp
 * @returns {{ kind: 'shoe'|'clothing', raw: string }|null}
 */
export function buildSerpV5OfficialUrlPdpTask(kwSizeForPdp) {
  if (!kwSizeForPdp) return null;
  if (kwSizeForPdp.type === 'shoe') {
    return { kind: 'shoe', raw: kwSizeForPdp.raw };
  }
  if (
    kwSizeForPdp.type === 'clothing' &&
    PDP_CLOTHING_ALPHAS.includes(String(kwSizeForPdp.raw || '').toUpperCase())
  ) {
    return { kind: 'clothing', raw: String(kwSizeForPdp.raw || '').toUpperCase() };
  }
  return null;
}

/**
 * v5 FINAL キーワード錨（色・必須サイズ・品番・商品名）が SERP 行の本文に存在するか。PDP②専用。
 *
 * @param {{ keyword?: string, colorKeywords?: string[], modelNumbers?: string[] }} entry
 * @param {object} item
 */
export function serpV5AnchorProgramMatch(entry, item) {
  if (!entry || !item || typeof item !== 'object') return false;
  const keyword = entry.keyword || '';
  const normalized = normalizeBrand(keyword);
  const hay = buildSerpPlainTextHaystack(item);

  if (!validateColorMatchForItem(item, keyword)) {
    return false;
  }

  const sizeInfos = collectRequiredSizeInfos(entry, keyword);
  for (let i = 0; i < sizeInfos.length; i++) {
    const si = sizeInfos[i];
    if (!hasSizeInTitleUniversal(hay, si)) return false;
  }

  const models = entry.modelNumbers || [];
  if (models.length > 0) {
    const t = hay.toUpperCase();
    const ok = models.some((m) => t.includes(String(m).toUpperCase()));
    if (!ok) return false;
  }
  if (!matchesProductKeyword(item, keyword, normalized)) return false;
  return true;
}

/**
 * @param {object|null|undefined} settings Redis user 設定（…obj 併合済み想定）
 * @returns {'male'|'female'|'unknown'}
 */
export function userGenderForSerpV5(settings) {
  if (!settings || typeof settings !== 'object') return 'unknown';
  const raw = settings.gender ?? settings.profileGender ?? '';
  const g = String(raw).trim().toLowerCase();
  if (g === 'male' || g === 'female') return g;
  return 'unknown';
}

/** §3 軽量：タイトルのみ（description はノイズ） */
export function titleMatchesLocalNoiseV5(item) {
  const t = String(item?.title || '');
  for (let i = 0; i < NOISE_KEYWORDS.length; i++) {
    const kw = NOISE_KEYWORDS[i];
    if (kw && t.includes(kw)) return true;
  }
  return false;
}

/**
 * @param {{ type: string, raw: string }|null|undefined} kwSizeForPdp
 */
export function kwPdpSizeEligible(kwSizeForPdp) {
  if (!kwSizeForPdp) return false;
  if (kwSizeForPdp.type === 'clothing') {
    return PDP_CLOTHING_ALPHAS.includes(String(kwSizeForPdp.raw || '').toUpperCase());
  }
  return kwSizeForPdp.type === 'shoe';
}

/**
 * §6 PDP 発火（①靴／服サイズ ②カテゴリ＋錨一致 ③ main かつ confidence≥0.85）
 * category は shoe|clothing|sticker|bag|cosmetics|other のみ想定（LLM 側で正規化）。
 *
 * @param {object} row classifySerpItemsBatch の1行
 * @param {object} item SERP 行
 * @param {{ keyword?: string, colorKeywords?: string[], modelNumbers?: string[] }|null|undefined} entry
 * @param {{ type: string, raw: string }|null|undefined} kwSizeForPdp
 * @returns {{ kind: 'shoe'|'clothing'|'generic', raw?: string }|null}
 */
export function resolveSerpV5PdpTask(row, item, entry, kwSizeForPdp) {
  const cat = String(row?.category || 'other');
  const role = String(row?.product_role || 'unknown');
  const conf = Number(row?.confidence);

  const shoeKw = kwSizeForPdp && kwSizeForPdp.type === 'shoe';
  const clothKw =
    kwSizeForPdp &&
    kwSizeForPdp.type === 'clothing' &&
    PDP_CLOTHING_ALPHAS.includes(String(kwSizeForPdp.raw || '').toUpperCase());

  if (shoeKw && cat === 'shoe') {
    return { kind: 'shoe', raw: kwSizeForPdp.raw };
  }
  if (clothKw && cat === 'clothing') {
    return { kind: 'clothing', raw: String(kwSizeForPdp.raw || '').toUpperCase() };
  }

  if (role === 'main' && Number.isFinite(conf) && conf >= 0.85) {
    return { kind: 'generic' };
  }

  const anchor = entry && serpV5AnchorProgramMatch(entry, item);
  if (['sticker', 'cosmetics', 'bag', 'other'].includes(cat) && anchor) {
    return { kind: 'generic' };
  }
  if (cat === 'clothing' && !clothKw && anchor) {
    return { kind: 'generic' };
  }
  return null;
}

/**
 * @param {object[]} items URL 付き・最大10・呼び出し側で重複排除済み推奨
 * @param {string} userGender male|female|unknown
 */
export async function classifyAndScoreSerpItemsV5(items, userGender) {
  const clean = [];
  if (Array.isArray(items)) {
    for (let i = 0; i < items.length && clean.length < 10; i++) {
      const it = items[i];
      if (!it?.url) continue;
      if (titleMatchesLocalNoiseV5(it)) continue;
      clean.push(it);
    }
  }
  if (clean.length === 0) return [];

  const labels = await classifySerpItemsBatch(clean);
  /** @type {Array<{ item: object, row: object, score: number }>} */
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const item = clean[i];
    const row = labels[i];
    const score = scoreSerpClassification(row, userGender, String(item?.title || '').toLowerCase());
    if (score < 0.6) continue;
    out.push({ item, row, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * **唯一の PDP 実行口**（靴／服／ジェネリック構造購入）。monitor / browse / 公式はここ経由のみ。
 * @param {object} item { url, ... }
 * @param {{ kind: 'shoe'|'clothing'|'generic', raw?: string }} task
 */
export async function runSerpV5PdpVerify(item, task) {
  if (!task || !task.kind) {
    return {
      ok: false,
      reason: 'no_pdp_task',
      method: 'none',
      pdpTentative: false,
      ms: 0,
    };
  }
  if (task.kind === 'shoe') return verifyShoeSizeOnPdp(item, task.raw);
  if (task.kind === 'clothing') return verifyClothingSizeOnPdp(item, String(task.raw || ''));
  return verifyGenericMainStructuralBuyOnPdp(item);
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<unknown>} mapper
 */
export async function pmapWithConcurrency(items, concurrency, mapper) {
  const n = Math.max(0, items.length);
  if (n === 0) return [];
  const slots = Math.max(1, Math.min(concurrency, n));
  const out = new Array(n);
  let wi = 0;
  async function worker() {
    while (true) {
      const i = wi++;
      if (i >= n) return;
      out[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: slots }, () => worker()));
  return out;
}

/**
 * browse 用：採用行（PDP 結果付き）を組み立てる。
 * @param {object[]} itemsDeduped SERP 最大10
 * @param {string} keyword
 * @param {string} userGender
 * @param {{ pdpParallel?: number }} [opts]
 */
export async function buildSerpFilterAdoptedList(itemsDeduped, keyword, userGender, opts = {}) {
  const kwSizeForPdp = extractSizeFromKeyword(keyword);
  const ruleEntry = buildSerpRuleEntryForKeyword(keyword);
  const scored = await classifyAndScoreSerpItemsV5(itemsDeduped, userGender);

  const pdpParallel = Math.max(
    1,
    Math.min(4, Number(opts.pdpParallel != null ? opts.pdpParallel : process.env.RE_EYE_MONITOR_PDP_PARALLEL) || 4),
  );

  const withTasks = [];
  for (let i = 0; i < scored.length; i++) {
    const rec = scored[i];
    const task = resolveSerpV5PdpTask(rec.row, rec.item, ruleEntry, kwSizeForPdp);
    withTasks.push({ ...rec, task });
  }

  const needPdp = withTasks.filter((w) => w.task);
  const pdpResults = await pmapWithConcurrency(needPdp, pdpParallel, async (w) => {
    const pdpv = await runSerpV5PdpVerify(w.item, w.task);
    return { ...w, pdpv };
  });
  const pdpByUrl = new Map();
  for (const w of pdpResults) {
    pdpByUrl.set(String(w.item?.url || ''), w);
  }

  /** @type {object[]} */
  const adopted = [];
  for (let i = 0; i < withTasks.length; i++) {
    const w = withTasks[i];
    const title = w.item?.title || '';
    const url = w.item?.url || '';
    const price = Number(w.item?.price) || 0;
    const shopName = w.item?.shopName || w.item?.sourceId || '';
    if (!w.task) {
      /** FINAL LOCK: CE を通した物理検証が無い行は最終採用しない（Redis 学習には載せない） */
      adopted.push({
        title,
        url,
        price,
        shopName,
        score: w.score,
        category: w.row.category,
        product_role: w.row.product_role,
        gender: w.row.gender,
        confidence: w.row.confidence,
        pdpStructural: null,
        pdpReason: 'v5_no_pdp_arm',
        pdpSkipped: true,
        ceStatus: 'reject',
        ceReason: '物理検証レイヤ未実行（PDP発火条件不備）',
        ceFlags: ['no_pdp_arm'],
        ceConfidencePenalty: 0,
        ceGenderMatch: true,
        finalAdopted: false,
      });
      continue;
    }
    const hit = pdpByUrl.get(String(url));
    const pdpv = hit?.pdpv;
    const structural = isSerpV5PdpDomStructuralOn(pdpv);
    const serpStrong = serpV5AnchorProgramMatch(ruleEntry, w.item);
    const ceOut = evaluateContradictionEngine({
      llmCategory: String(w.row?.category || 'other'),
      llmConfidence: Number(w.row?.confidence) || 0,
      serpStrongMatch: serpStrong,
      pdpResult: structural ? 'on' : 'off',
      pdpRetryable: !!pdpv?.retryable,
      pdpReason: String(pdpv?.reason || ''),
      userGender,
      productGender: String(w.row?.gender || 'unknown'),
      productRole: String(w.row?.product_role || 'unknown'),
    });
    const finalAdopted = isSerpV5FinalStockOn(pdpv, ceOut);
    if (ceOut.status === 'reject') {
      void recordCeRejectionSafe({
        source: 'browse_serp',
        flags: ceOut.flags || [],
        reason: ceOut.reason || '',
        keyword: String(keyword || ruleEntry?.keyword || ''),
        urlHost: ceFeedbackUrlHost(w.item?.url),
      });
    }
    adopted.push({
      title,
      url,
      price,
      shopName,
      score: w.score,
      category: w.row.category,
      product_role: w.row.product_role,
      gender: w.row.gender,
      confidence: w.row.confidence,
      pdpStructural: structural,
      pdpReason: String(pdpv?.reason || ''),
      pdpSkipped: false,
      ceStatus: ceOut.status,
      ceReason: ceOut.reason,
      ceFlags: ceOut.flags,
      ceConfidencePenalty: ceOut.confidencePenalty,
      ceGenderMatch: ceOut.genderMatch,
      finalAdopted,
    });
  }

  return { adopted, scoredCount: scored.length, kwSizeForPdp, ruleEntry };
}
