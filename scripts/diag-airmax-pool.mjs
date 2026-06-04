/**
 * 本番 API 実測（読み取りのみ）。修正なし。
 * node scripts/diag-airmax-pool.mjs
 */
const ORIGIN = 'https://re-eye-hub.vercel.app';
const API = `${ORIGIN}/api?action=search`;

async function postSearch(limit) {
  const body = {
    keyword: 'エアマックス90 26.5',
    userId: 'u_diagpool20',
    sequentialPdp: true,
    limit,
    shoeCm: 26.5,
    plan: 'PRO',
    prePdpScanIndex: 0,
  };
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`HTTP ${res.status} parse fail: ${text.slice(0, 200)}`);
  }
  return { status: res.status, data };
}

function pickSummary(data) {
  const t = data.searchTrace || {};
  return {
    itemsFinalLen: t.itemsFinalLen ?? (data.items || []).length,
    pdpCalls: t.pdpCalls ?? data.searchCursor?.pdpCallsThisRequest,
    poolLength: t.poolLength,
    stopReason: t.stopReason,
    topExclusions: (t.topExclusions || []).map((x) => ({
      title: x.title,
      url: x.url,
      sizeMatchExact: x.sizeMatchExact,
      excludeReason: x.excludeReason,
    })),
  };
}

function allAuditRows(data) {
  const audit =
    data.stockSizeAudit ||
    data.debug?.audit?.stockSizeAudit ||
    data.debug?.stockSizeAudit;
  return Array.isArray(audit?.rows) ? audit.rows : [];
}

const { status, data } = await postSearch(1);
if (status !== 200) {
  console.error('search failed', status, data);
  process.exit(1);
}

const rows = allAuditRows(data);
const poolLen = data.searchTrace?.poolLength ?? data.searchCursor?.poolLength;

console.log('=== POOL AUDIT ROWS (API returned) ===');
console.log(`HTTP ${status} poolLength=${poolLen} auditRowsReturned=${rows.length}`);
console.log('');

const table = rows.map((r, i) => ({
  n: i + 1,
  title: r.title,
  url: r.url,
  sizeMatchExact: r.sizeMatchExact,
  excludeReason: r.excludeReason,
  pdpMerged: r.pdpMerged,
  pdpOk: r.pdpOk,
  pdpReason: r.pdpReason,
}));

console.log(JSON.stringify(table, null, 2));

const pdpNotScanned = rows.filter((r) => r.excludeReason === 'pdp_not_scanned');
console.log('');
console.log(`=== pdp_not_scanned count in audit rows: ${pdpNotScanned.length} / ${rows.length} ===`);

console.log('');
console.log('=== LIMIT COMPARISON (sequentialPdp, prePdpScanIndex=0) ===');

for (const lim of [1, 5, 20]) {
  const { status: st, data: d } = await postSearch(lim);
  const s = pickSummary(d);
  const staged = d.searchCursor?.staged;
  console.log(JSON.stringify({
    limit: lim,
    http: st,
    itemsFinalLen: s.itemsFinalLen,
    pdpCalls: s.pdpCalls,
    poolLength: s.poolLength,
    stopReason: s.stopReason,
    sequentialBatch: staged?.sequentialBatch,
    pdpScannedThisRequest: staged?.pdpScannedThisRequest,
    topExclusionsCount: s.topExclusions.length,
    topExclusions: s.topExclusions,
  }, null, 2));
  console.log('---');
}
