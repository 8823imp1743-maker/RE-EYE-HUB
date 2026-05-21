/**
 * 在庫監視の Redis キー・スキーマ・TTL の単一ソース。
 * api/monitor.js / seed.mjs 双方から import する。
 */
import { createHash } from 'crypto';

/**
 * スキーマバージョン — monitor.js のフィルター変更時はここだけ更新する。
 * 新しいフィルター導入後は必ずバージョンを上げる。
 */
export const MONITOR_SCHEMA_VERSION = '2026-04-18-v12'; // ルールベースのみ（Gemini 排除）

/** 監視エントリ JSON の TTL（秒） */
export const WATCH_TTL = 60 * 60 * 24 * 90; // 90日

/** Cron 用: 監視エントリの Redis キー文字列の集合 */
export const GLOBAL_MONITOR_KEYS_SET = 'monitor:global:keys';

/** `monitor:global:keys` の TTL（秒）。register / seed で共通利用 */
export const GLOBAL_MONITOR_KEYS_SET_TTL_SEC = 86400 * 400;

/** 監視エントリ本体のキー接頭辞（`monitor:user:` / `monitor:global:` とは別） */
export const MONITOR_ENTRY_PREFIX = 'monitor:';

/**
 * プラン保存キー（getStockIntervalForPlan の参照先と一致）
 * @param {string} userId
 */
export function userPlanKey(userId) {
  return `user:plan:${String(userId ?? '').trim()}`;
}

/**
 * 同一ユーザー・同一モール行の短期通知重複抑止（10分 TTL）
 * キー形式: notify:sent:{userId}:{itemSlot}（Redis キー長対策で item 側はハッシュ短縮）
 * @param {string} userId
 * @param {string} sourceId
 * @param {string|number} itemId
 */
export function notifySentDedupeKey(userId, sourceId, itemId) {
  const uid = String(userId ?? '').trim().slice(0, 48);
  const slot = `${String(sourceId ?? '')}::${String(itemId ?? '')}`;
  const h = createHash('sha256').update(slot).digest('hex').slice(0, 24);
  return `notify:sent:${uid}:${h}`;
}

/**
 * 監視エントリ本体のキーか（SMEMBERS / KEYS のフィルタ用）
 * @param {string} k
 */
export function isMonitorEntryRedisKey(k) {
  return (
    typeof k === 'string' &&
    k.startsWith(MONITOR_ENTRY_PREFIX) &&
    !k.startsWith('monitor:user:') &&
    !k.startsWith('monitor:global:')
  );
}

/** KEYS 用: 全監視エントリ候補（`monitor:user:*` は別キーのため含まれない） */
export function monitorEntryKeysGlobPattern() {
  return `${MONITOR_ENTRY_PREFIX}*`;
}

/**
 * KEYS 用: 1 ユーザーの監視エントリ
 * @param {string} userId
 */
export function monitorUserEntryKeysPattern(userId) {
  return `${MONITOR_ENTRY_PREFIX}${String(userId ?? '').trim()}:*`;
}

/**
 * @param {string} userId
 * @param {string} hash 16桁 hex
 */
export function watchKey(userId, hash) {
  return `${MONITOR_ENTRY_PREFIX}${userId}:${hash}`;
}

export function userWatchIndexKey(userId) {
  return `monitor:user:${userId}`;
}

export function itemHashKey(sourceId, itemId) {
  return createHash('sha256')
    .update(`${sourceId}:${itemId}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * mget の結果を監視エントリに復元する。schemaVersion が違っても捨てずに entries に含める。
 * @returns {{ entries: object[], issues: { key: string, type: string, message: string, preview?: string }[] }}
 */
export function parseMonitorEntriesFromMget(keys, values, expectedSchemaVersion) {
  const entries = [];
  const issues = [];
  const exp = expectedSchemaVersion;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const raw = values[i];

    if (raw == null || raw === '') {
      issues.push({
        key,
        type: 'empty',
        message:
          '値が null / 空です（monitor:global:keys にキーだけ残っている、TTL 切れ、別 DB を見ている等の可能性）',
      });
      continue;
    }

    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      issues.push({
        key,
        type: 'json',
        message: `JSON 解析失敗: ${e.message}`,
        preview: String(raw).slice(0, 240),
      });
      continue;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      issues.push({
        key,
        type: 'type',
        message: 'パース結果がオブジェクトではありません',
      });
      continue;
    }

    const actual = parsed.schemaVersion;
    if (actual !== exp) {
      issues.push({
        key,
        type: 'schema',
        message: `schemaVersion 不一致（エントリは読み込みます）: 期待="${exp}" 実際="${actual ?? '(フィールドなし)'}"`,
      });
    }

    entries.push(parsed);
  }

  return { entries, issues };
}
