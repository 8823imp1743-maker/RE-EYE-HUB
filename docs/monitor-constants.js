export const MONITOR_SCHEMA_VERSION = 'V6.4';

export const WATCH_TTL =
  60 * 60 * 24 * 30;

export function notifySentDedupeKey(
  userId,
  source,
  identity
) {
  return `notify:${userId}:${source}:${identity}`;
}

export function watchKey(
  userId,
  hash
) {
  return `watch:${userId}:${hash}`;
}

export function itemHashKey(
  sourceId,
  itemId
) {
  return `${sourceId}:${itemId}`;
}

export default {
  MONITOR_SCHEMA_VERSION,
  WATCH_TTL,
  notifySentDedupeKey,
  watchKey,
  itemHashKey
};