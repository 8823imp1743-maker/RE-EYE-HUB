/**
 * プロフィール cm とキーワード確定 listing cm の完全一致（fail-close／±やスナップ拡張なし）。
 */

import { getUserShoeCmRawForPostFilter } from './user-size.js';
import { listingCmFromSizeInfo } from './size-bucket-tags.js';

/**
 * @param {object|null|undefined} settings
 * @returns {number|null}
 */
export function profileAdultShoeCm(settings) {
  if (!settings) return null;
  const raw = getUserShoeCmRawForPostFilter(settings, false);
  if (!raw) return null;
  const n = parseFloat(String(raw).replace(/cm$/i, '').trim());
  if (!Number.isFinite(n)) return null;
  if (n < 14 || n > 35) return null;
  return Math.round(n * 10) / 10;
}

/**
 * 靴のみ fail-close（profile / listing が片方でも欠けたら不許可・数値完全一致）。
 * 靴以外サイズタイプでは従来どおり許可。
 * @param {object|null|undefined} settings
 * @param {{ type: string, raw: string }|null|undefined} sizeInfo
 */
export function shoeProfileAllowsListing(settings, sizeInfo) {
  if (!sizeInfo || sizeInfo.type !== 'shoe') return true;
  const listing = listingCmFromSizeInfo(sizeInfo);
  const profile = profileAdultShoeCm(settings);
  if (listing == null || profile == null) return false;
  return listing === profile;
}
