/**
 * 靴在庫ゲートの診断ログ — Vercel Logs で「どの段階で落ちたか」を追跡する。
 * タグ: [RE_EYE_STOCK_AUDIT][<stage>]
 */

/** 診断表示用（pdp-shoe-stock の coerceTargetCmStrings と同等の最小実装） */
function coerceTargetCmStringsForAudit(inp) {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n) || n < 10 || n > 35) return;
    const k = String(n);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  const arr = Array.isArray(inp) ? inp : inp != null ? [inp] : [];
  arr.forEach((x) => {
    const st = String(x ?? '').trim();
    if (!st) return;
    if (st.includes(',')) st.split(/[,、]/).forEach((p) => add(p));
    else add(st);
  });
  return out;
}

function normalizeCm(v) {
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function isInvalidSizeExpression(hay) {
  if (!hay) return true;
  if (/\d{2}(?:\.\d)?\s*[-～〜]\s*\d{2}\s*(cm|㎝)/.test(hay)) return true;
  if (/約\s*\d{2}(?:\.\d)?\s*(cm|㎝)/.test(hay)) return true;
  if (/前後\s*\d{2}(?:\.\d)?\s*(cm|㎝)/.test(hay)) return true;
  return false;
}

/** SERP 承認形式: `\d{2}(?:\.\d)?` + 直後 `cm|㎝` のみ */
function serpExtractApprovedCms(hay) {
  if (!hay) return [];
  if (isInvalidSizeExpression(hay)) return [];
  const matches = [...String(hay).matchAll(/(?<!\d)(\d{2}(?:\.\d)?)(?!\d)\s*(cm|㎝)/g)];
  return matches.map((m) => Number(m[1])).filter(Number.isFinite);
}

function extractBareCmTokens(hay) {
  if (!hay) return [];
  return [...String(hay).matchAll(/\b(\d{2}\.\d)\b/g)].map((m) => m[1]);
}

function extractJpUsTokens(hay) {
  if (!hay) return { jp: [], us: [] };
  const jp = [...String(hay).matchAll(/JP\s*(\d{2}(?:\.\d)?)/gi)].map((m) => m[1]);
  const us = [...String(hay).matchAll(/US\s*(\d+(?:\.\d)?)/gi)].map((m) => m[1]);
  return { jp, us };
}

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

function resolveExcludeReason({ invalidHay, exact, extractedApproved, targets, pdpScanned, pdpOk, pdpReason, pdpTentative }) {
  if (invalidHay) return 'invalid_size_expression_in_hay';
  // PDP 確定なら SERP cm 字面不一致でも pass（ゲート bypass と整合）
  if (pdpOk === true) {
    if (pdpTentative) return 'pdp_tentative';
    return null;
  }
  if (!extractedApproved.length) return 'serp_no_approved_cm_token';
  if (!exact) return 'serp_cm_mismatch';
  if (!pdpScanned) return 'pdp_not_scanned';
  if (pdpOk !== true) return `pdp_fail:${pdpReason || 'unknown'}`;
  if (pdpTentative) return 'pdp_tentative';
  return null;
}

export function logStockAudit(stage, payload) {
  try {
    console.log(`[RE_EYE_STOCK_AUDIT][${stage}]`, JSON.stringify(payload));
  } catch {
    console.log(`[RE_EYE_STOCK_AUDIT][${stage}]`, payload);
  }
}

/** 検索開始時: ユーザー指定サイズ */
export function logStockAuditTargets({ shoeTargetNums, shoeSizeRaw, plan, keyword, forChild }) {
  const userTargets = (shoeTargetNums || []).map((n) => normalizeCm(n)).filter((n) => n !== null);
  const pdpCoerced =
    shoeTargetNums?.length >= 1
      ? coerceTargetCmStringsForAudit(shoeTargetNums.map((n) => String(n)).join(','))
      : coerceTargetCmStringsForAudit(shoeSizeRaw);
  logStockAudit('targets', {
    userTargets,
    userTargetsRaw: shoeTargetNums,
    shoeSizeRaw: shoeSizeRaw != null ? String(shoeSizeRaw) : null,
    pdpCoercedTargets: pdpCoerced,
    plan,
    keyword: keyword != null ? String(keyword).slice(0, 120) : null,
    forChild: !!forChild,
  });
}

/** 楽天・Yahoo モール API 生データ（先頭 N 件） */
export function logStockAuditMallRaw(allItems, { mallPage, kwHint }) {
  if (!Array.isArray(allItems) || allItems.length === 0) {
    logStockAudit('mall-raw', { mallPage, kwHint, total: 0, sample: [] });
    return;
  }
  const bySource = {};
  for (const it of allItems) {
    const sid = it?.sourceId || 'unknown';
    if (!bySource[sid]) bySource[sid] = [];
    if (bySource[sid].length < 3) {
      bySource[sid].push({
        title: String(it.title || '').slice(0, 140),
        available: it.available,
        price: it.price,
        url: String(it.url || '').slice(0, 100),
      });
    }
  }
  logStockAudit('mall-raw', {
    mallPage,
    kwHint: kwHint != null ? String(kwHint).slice(0, 80) : null,
    total: allItems.length,
    bySource,
  });
}

/**
 * 1 商品のゲート判定（SERP cm + PDP 確定の AND）
 * @param {object} opts
 */
export function auditShoeGateRow(opts) {
  const {
    hay = '',
    title = '',
    url = '',
    targets = [],
    mallAvailable,
    pdpMerged,
    pdpOk,
    pdpReason,
    pdpTentative,
    pdpScanned,
  } = opts;

  const extractedApproved = serpExtractApprovedCms(hay);
  const normalizedExtracted = extractedApproved.map((n) => normalizeCm(n)).filter((n) => n !== null);
  const userTargets = (targets || []).map((t) => normalizeCm(t)).filter((n) => n !== null);
  const bareTokens = extractBareCmTokens(hay);
  const jpUs = extractJpUsTokens(hay);
  const invalidHay = isInvalidSizeExpression(hay);
  const exact = computeExactCmMatch(hay, targets);
  const excludeReason = resolveExcludeReason({
    invalidHay,
    exact,
    extractedApproved,
    targets: userTargets,
    pdpScanned: !!pdpScanned,
    pdpOk,
    pdpReason,
    pdpTentative: !!pdpTentative,
  });
  const gatePass = excludeReason === null;

  return {
    title: String(title).slice(0, 100),
    url: String(url).slice(0, 90),
    mallAvailable: mallAvailable === true,
    pdpMerged: !!pdpMerged,
    extractedSizesApproved: extractedApproved,
    normalizedExtracted,
    bareNumericInHay: bareTokens,
    jpUsTokens: jpUs,
    userTargets,
    sizeMatchExact: exact,
    pdpOk: pdpOk === true,
    pdpReason: pdpReason || null,
    gatePass,
    excludeReason: gatePass ? null : excludeReason,
  };
}

/** プール上位を一括監査 */
export function buildShoeGateAuditBatch(poolItems, targets, buildHaystack, mapForClient, limit = 12) {
  const rows = [];
  for (const it of (poolItems || []).slice(0, limit)) {
    const hay = typeof buildHaystack === 'function' ? buildHaystack(it) : '';
    const mapped = typeof mapForClient === 'function' ? mapForClient(it) : null;
    const psc = mapped?.pdpSizeCheck;
    rows.push(
      auditShoeGateRow({
        hay,
        title: it.title,
        url: it.url,
        targets,
        mallAvailable: it.available,
        pdpMerged: !!it.pdpMerged,
        pdpOk: it.ok,
        pdpReason: it.reason,
        pdpTentative: it.pdpTentative,
        pdpScanned: psc?.scanned === true,
      })
    );
  }
  const passed = rows.filter((r) => r.gatePass).length;
  logStockAudit('gate-batch', {
    audited: rows.length,
    gatePassed: passed,
    gateFailed: rows.length - passed,
    rows,
  });
  return { rows, passed, failed: rows.length - passed };
}
