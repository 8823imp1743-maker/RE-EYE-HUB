/**
 * seenキー生成・正規化
 * sourceTypeごと: web=url優先(id), x=id, instagram=id
 */

import { createHash } from 'crypto';

export function getSeenKey(userId, sourceId, item, sourceType) {
  const raw = normalizeForSeen(item, sourceType);
  const hash = createHash('sha256').update(raw).digest('hex');
  return `seen:${userId}:${sourceId}:${hash}`;
}

function normalizeForSeen(item, sourceType) {
  switch (sourceType) {
    case 'web':
      return (item.url || item.id || '').trim().toLowerCase();
    case 'x':
    case 'instagram':
      return String(item.id || '').trim();
    default:
      return (item.url || item.id || '').trim().toLowerCase();
  }
}
