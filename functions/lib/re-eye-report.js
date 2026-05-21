import { createHash } from 'crypto';

/**
 * RE_EYE 正規化（REPORT/分析の共通前処理）
 * @param {unknown} v
 */
export function reEyeNormalize(v) {
  if (!v) return '';
  return String(v)
    .replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, '.')
    .toUpperCase()
    .trim();
}

/**
 * @param {string} s
 */
export function hashKey(s) {
  const t = String(s || '').trim();
  return createHash('sha256').update(t).digest('hex').slice(0, 24);
}

/** snapshotVersion の唯一の既定値（互換性分離） */
export const RE_EYE_REPORT_SNAPSHOT_VERSION = Object.freeze({
  id: '2',
  logic: '1',
  api: '1',
});

/**
 * snapshotVersion を正規化（string / object を許容）
 * @param {any} v
 */
export function normalizeSnapshotVersion(v) {
  if (!v) return { ...RE_EYE_REPORT_SNAPSHOT_VERSION };
  if (typeof v === 'string') {
    const id = String(v).trim() || RE_EYE_REPORT_SNAPSHOT_VERSION.id;
    return { id: id.slice(0, 16), logic: RE_EYE_REPORT_SNAPSHOT_VERSION.logic, api: RE_EYE_REPORT_SNAPSHOT_VERSION.api };
  }
  if (typeof v !== 'object') return { ...RE_EYE_REPORT_SNAPSHOT_VERSION };
  return {
    id: String(v.id || RE_EYE_REPORT_SNAPSHOT_VERSION.id).trim().slice(0, 16) || RE_EYE_REPORT_SNAPSHOT_VERSION.id,
    logic: String(v.logic || RE_EYE_REPORT_SNAPSHOT_VERSION.logic).trim().slice(0, 16) || RE_EYE_REPORT_SNAPSHOT_VERSION.logic,
    api: String(v.api || RE_EYE_REPORT_SNAPSHOT_VERSION.api).trim().slice(0, 16) || RE_EYE_REPORT_SNAPSHOT_VERSION.api,
  };
}

/**
 * 安定ID（フロント `reEyeReportStableId` と同一ロジック必須）
 * @param {any} it
 */
export function stableReportItemId(it) {
  if (!it || typeof it !== 'object') return '';
  const sourceId = String(it.sourceId || it.source || '').trim();
  const itemId = String(it.itemId || '').trim();
  const title = String(it.title || '').trim().slice(0, 160);
  const price = String(it.price || '').trim();
  const shop = String(it.shopName || it.sellerName || '').trim().slice(0, 80);
  return ('f:' + [sourceId, itemId, title, price, shop].join('|')).slice(0, 420);
}

/**
 * REPORT 入力の正規化（最終形のみ。旧キーは受け付けない）
 * @param {any} inReport
 */
export function sanitizeReportInput(inReport) {
  const r = inReport && typeof inReport === 'object' ? inReport : {};
  const query = String(r.query || '').trim().slice(0, 200);

  const targetSize = r.targetSize != null ? String(r.targetSize).trim().slice(0, 32) : '';
  const color = r.color != null ? String(r.color).trim().slice(0, 80) : '';

  const apiItems = Array.isArray(r.apiItems) ? r.apiItems.slice(0, 200) : [];

  const displayItemIds = (Array.isArray(r.displayItemIds) ? r.displayItemIds : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 200);

  const userProfile = r.userProfile && typeof r.userProfile === 'object' ? r.userProfile : null;

  const snapshotVersion = normalizeSnapshotVersion(r.snapshotVersion);

  const sourceApi =
    r.sourceApi != null && String(r.sourceApi).trim() ? String(r.sourceApi).trim().slice(0, 40) : 'unknown';
  const userId = r.userId != null && String(r.userId).trim() ? String(r.userId).trim().slice(0, 96) : null;

  return {
    query,
    userProfile,
    targetSize,
    color,
    apiItems,
    displayItemIds,
    snapshotVersion,
    sourceApi,
    userId,
  };
}

/**
 * サーバーで表示集合を再構築（ID のみに基づく）
 * @param {any[]} apiItems
 * @param {string[]} displayItemIds
 */
export function rebuildDisplay(apiItems, displayItemIds) {
  const api = Array.isArray(apiItems) ? apiItems : [];
  const ids = Array.isArray(displayItemIds) ? displayItemIds : [];
  if (api.length === 0 || ids.length === 0) return [];
  const set = new Set(ids.map((x) => String(x || '').trim()).filter(Boolean));
  return api.filter((it) => {
    const k = stableReportItemId(it);
    return k ? set.has(k) : false;
  });
}

/**
 * excluded = apiItems − rebuildDisplay（サーバー専用）
 * @param {any[]} apiItems
 * @param {any[]} displayItemsRebuilt
 */
export function diffExcluded(apiItems, displayItemsRebuilt) {
  const api = Array.isArray(apiItems) ? apiItems : [];
  const disp = Array.isArray(displayItemsRebuilt) ? displayItemsRebuilt : [];
  const seen = new Set();
  for (const d of disp) {
    const k = stableReportItemId(d);
    if (k) seen.add(k);
  }
  return api.filter((a) => {
    const k = stableReportItemId(a);
    if (!k) return true;
    return !seen.has(k);
  });
}

/**
 * 分析（クライアント excluded は無視。常に apiItems + displayItemIds から再計算）
 * @param {any} report — sanitize 済み想定
 */
export function analyzeReport(report) {
  const r = report && typeof report === 'object' ? report : {};
  let sizeMismatchCount = 0;
  let colorMismatchCount = 0;
  let noSizeDataCount = 0;

  const targetSize = r.targetSize != null ? String(r.targetSize).trim() : '';
  const color = r.color != null ? String(r.color).trim() : '';

  const rebuilt = rebuildDisplay(r.apiItems, r.displayItemIds);
  const excluded = diffExcluded(r.apiItems, rebuilt);

  for (const i of excluded) {
    const t = reEyeNormalize(i && i.title);
    if (targetSize) {
      if (!t) {
        noSizeDataCount++;
        sizeMismatchCount++;
      } else if (!t.includes(String(targetSize).toUpperCase())) {
        sizeMismatchCount++;
      }
    }
    if (color) {
      if (!t) {
        colorMismatchCount++;
      } else if (!t.includes(String(color).toUpperCase())) {
        colorMismatchCount++;
      }
    }
  }

  const apiReturnedCount = Array.isArray(r.apiItems) ? r.apiItems.length : 0;
  const displayedCount = rebuilt.length;

  const apiExpansionRisk = displayedCount > 0 ? apiReturnedCount > displayedCount * 5 : apiReturnedCount >= 30;

  const severity = apiExpansionRisk || sizeMismatchCount > 10 ? 'high' : sizeMismatchCount > 5 ? 'medium' : 'low';

  return { sizeMismatchCount, colorMismatchCount, noSizeDataCount, apiExpansionRisk, severity };
}

function brandFromTitle(title = '') {
  const t = String(title || '').toUpperCase();
  const list = ['NIKE', 'ADIDAS', 'PUMA', 'ASICS', 'NB'];
  return list.find((b) => t.includes(b)) || 'UNKNOWN';
}

function excludedForStoredReport(r) {
  if (!r || typeof r !== 'object') return [];
  /** 保存済みのみ対象（最終形の displayItemIds 必須。旧レコードは集計対象外） */
  if (!Array.isArray(r.displayItemIds)) return [];
  const rebuilt = rebuildDisplay(r.apiItems, r.displayItemIds);
  return diffExcluded(r.apiItems, rebuilt);
}

/**
 * @param {any[]} reports
 */
export function buildDashboard(reports) {
  const rs = Array.isArray(reports) ? reports : [];

  const brokenMap = new Map();
  const brandMap = new Map();
  const sizeMap = new Map();
  const apiMap = new Map();

  for (const r of rs) {
    const query = String((r && r.query) || '').trim() || 'UNKNOWN_QUERY';
    /** @type {ReturnType<typeof analyzeReport>} */
    let analysis;
    if (r && r.analysis) {
      analysis = r.analysis;
    } else if (Array.isArray(r.displayItemIds) && Array.isArray(r.apiItems)) {
      analysis = analyzeReport({
        query: r.query,
        targetSize: r.targetSize,
        color: r.color,
        apiItems: r.apiItems,
        displayItemIds: r.displayItemIds,
      });
    } else {
      analysis = {
        sizeMismatchCount: 0,
        colorMismatchCount: 0,
        noSizeDataCount: 0,
        apiExpansionRisk: false,
        severity: 'low',
      };
    }

    if (!brokenMap.has(query)) brokenMap.set(query, { query, score: 0 });
    const br = brokenMap.get(query);
    br.score += (Number(analysis.sizeMismatchCount) || 0) * 2 + (Number(analysis.colorMismatchCount) || 0) + (analysis.apiExpansionRisk ? 5 : 0);

    const excluded = excludedForStoredReport(r);
    for (const it of excluded) {
      const b = brandFromTitle(it && it.title);
      if (!brandMap.has(b)) brandMap.set(b, { brand: b, errors: 0 });
      brandMap.get(b).errors++;
    }

    const s = r && r.targetSize != null ? String(r.targetSize).trim() : '';
    if (s) {
      if (!sizeMap.has(s)) sizeMap.set(s, { size: s, total: 0, errors: 0 });
      const m = sizeMap.get(s);
      m.total++;
      if ((Number(analysis.sizeMismatchCount) || 0) > 0) m.errors++;
    }

    const api = r && r.sourceApi ? String(r.sourceApi) : 'unknown';
    if (!apiMap.has(api)) apiMap.set(api, { api, total: 0, errors: 0 });
    const am = apiMap.get(api);
    am.total++;
    if ((Number(analysis.sizeMismatchCount) || 0) > 0) am.errors++;
  }

  const brokenRanking = [...brokenMap.values()].sort((a, b) => b.score - a.score).slice(0, 50);
  const brandStats = [...brandMap.values()].sort((a, b) => b.errors - a.errors).slice(0, 50);
  const sizeHeatmap = [...sizeMap.values()].map((x) => ({ size: x.size, errorRate: x.total ? x.errors / x.total : 0 }));
  const apiScores = [...apiMap.values()]
    .map((a) => ({ api: a.api, score: a.total ? 100 - (a.errors / a.total) * 100 : 100 }))
    .sort((a, b) => b.score - a.score);

  return { brokenRanking, brandStats, sizeHeatmap, apiScores };
}
