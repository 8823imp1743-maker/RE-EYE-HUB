/** @param {string|null|undefined} p */
export function isPaidPlan(p) {
  const v = String(p || '').trim().toUpperCase();
  return v === 'STANDARD' || v === 'PRO' || v === 'VIP';
}

/** Redis user:plan の生値 → 正規トークン（不明は FREE） */
export function coercePlanTier(p) {
  const v = String(p ?? '').trim().toUpperCase();
  if (v === 'STANDARD' || v === 'PRO' || v === 'VIP' || v === 'FREE') return v;
  return 'FREE';
}

/** RE_EYE_DIGEST_ENABLE + RE_EYE_DIGEST_SCOPE */
export function digestPathForPlan(plan, env = process.env) {
  const on =
    env.RE_EYE_DIGEST_ENABLE === '1' || env.RE_EYE_DIGEST_ENABLE === 'true';
  if (!on) return 'instant';
  const scope = String(env.RE_EYE_DIGEST_SCOPE || 'all').toLowerCase();
  if (scope === 'paid_fast' || scope === 'free_only') {
    return isPaidPlan(plan) ? 'instant' : 'digest';
  }
  return 'digest';
}

/**
 * uid ごとに 0〜99 の決定的値（セッションなし）。
 * @param {string} uid
 */
export function stablePercentBucket(uid) {
  const s = String(uid || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 100;
}

/**
 * TAG 送信のサイズフィルタ AND を「段階導入」する。
 * ONESIGNAL_USE_SIZE_TAG_FILTERS=1 が前提だが、この関数が false のときは userId のみ送信。
 *
 * env:
 * RE_EYE_TAG_FILTER_ROLLOUT_PCT — 0〜100（例:10 で約10%のユーザーだけ AND）
 */
export function shouldApplyTagAndFilter(userId, env = process.env) {
  const pct = Number(env.RE_EYE_TAG_FILTER_ROLLOUT_PCT);
  if (!Number.isFinite(pct) || pct <= 0) return false;
  if (pct >= 100) return true;
  return stablePercentBucket(userId) < pct;
}
