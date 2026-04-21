#!/usr/bin/env node
/**
 * Upstash に SERP 在庫監視のテスト用エントリを 1 件書き込む。
 *
 * 前提: functions/.env に UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 *
 *   node seed.mjs
 *   node seed.mjs --keyword "別のキーワード"
 *
 * Redis のキーは lib/monitor-constants.js の `watchKey` と同じ `monitor:{userId}:{16桁ハッシュ}` です。
 * スキーマ版は同ファイルの `MONITOR_SCHEMA_VERSION` をそのまま使います。
 *
 * 書き込み後に `node run-cli.mjs` で楽天・Yahoo 検索まで通るか確認できます。
 */
import 'dotenv/config';
import { getRedis, withRedisRetry } from './lib/redis.js';
import {
  MONITOR_SCHEMA_VERSION,
  WATCH_TTL,
  GLOBAL_MONITOR_KEYS_SET,
  GLOBAL_MONITOR_KEYS_SET_TTL_SEC,
  watchKey,
  userWatchIndexKey,
  userPlanKey,
  itemHashKey,
} from './lib/monitor-constants.js';

function parseArgs(argv) {
  const out = {
    userId: process.env.SEED_USER_ID || 'test_user',
    sourceId: process.env.SEED_SOURCE_ID || 'rakuten',
    itemId: process.env.SEED_ITEM_ID || 'seed_item_1',
    keyword: process.env.SEED_KEYWORD || 'HQ7001-001',
    title: process.env.SEED_TITLE || '【実機】ボメロ 18 GTX 26.5cm',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keyword' && argv[i + 1]) {
      out.keyword = argv[++i];
    } else if (a === '--user' && argv[i + 1]) {
      out.userId = argv[++i];
    } else if (a === '--item-id' && argv[i + 1]) {
      out.itemId = argv[++i];
    } else if (a === '--source-id' && argv[i + 1]) {
      out.sourceId = argv[++i];
    } else if (a === '--title' && argv[i + 1]) {
      out.title = argv[++i];
    }
  }
  return out;
}

(async () => {
  const { userId, sourceId, itemId, keyword, title } = parseArgs(process.argv);

  const hash = itemHashKey(sourceId, itemId);
  const key = watchKey(userId, hash);

  // 楽天商品 URL だが OFFICIAL_DOMAINS に含まれない → SERP 監視パス（searchAllCached）
  const url =
    process.env.SEED_URL ||
    'https://item.rakuten.co.jp/example/seed-test-item/';

  const entry = {
    keyword: String(keyword).trim(),
    itemId: String(itemId).trim().toLowerCase(),
    sourceId: String(sourceId).trim().toLowerCase(),
    userId: String(userId).trim(),
    url,
    title: String(title).trim(),
    price: 0,
    listPrice: 0,
    modelNumbers: [],
    colorKeywords: ['26.5'],
    status: 'OFF',
    addedAt: Date.now(),
    // 0 だとインターバル条件をすぐ満たし、run-cli で必ずチェック対象になる
    lastCheckedAt: 0,
    notifiedAt: 0,
    schemaVersion: MONITOR_SCHEMA_VERSION,
    // serpUrls 未設定 → 初回はベースライン確立のみ（2 回目以降から差分検知）
  };

  let r;
  try {
    r = getRedis();
  } catch (e) {
    console.error('[seed] Redis 初期化失敗:', e.message);
    process.exit(1);
  }

  try {
    await withRedisRetry(
      () => r.set(userPlanKey(userId), 'VIP', { ex: WATCH_TTL }),
      { label: 'seed:plan' }
    );
    await withRedisRetry(() => r.set(key, JSON.stringify(entry), { ex: WATCH_TTL }), { label: 'seed:entry' });
    await withRedisRetry(() => r.sadd(userWatchIndexKey(userId), hash), { label: 'seed:index' });
    await withRedisRetry(() => r.expire(userWatchIndexKey(userId), WATCH_TTL), { label: 'seed:index-ttl' });
    await withRedisRetry(() => r.sadd(GLOBAL_MONITOR_KEYS_SET, key), { label: 'seed:global-key' });
    await withRedisRetry(() => r.expire(GLOBAL_MONITOR_KEYS_SET, GLOBAL_MONITOR_KEYS_SET_TTL_SEC), {
      label: 'seed:global-ttl',
    }).catch(() => {});

    const roundTrip = await withRedisRetry(() => r.get(key), { label: 'seed:verify-get' });
    if (roundTrip == null || roundTrip === '') {
      console.error('[seed] 検証失敗: SET 直後の GET が空です。キーと Upstash の DB が一致しているか確認してください。');
      process.exit(1);
    }
    try {
      const parsed = typeof roundTrip === 'string' ? JSON.parse(roundTrip) : roundTrip;
      if (parsed?.schemaVersion !== MONITOR_SCHEMA_VERSION) {
        console.error(
          `[seed] 検証失敗: schemaVersion が ${MONITOR_SCHEMA_VERSION} ではありません (実際=${parsed?.schemaVersion})`
        );
        process.exit(1);
      }
    } catch (e) {
      console.error('[seed] 検証失敗: JSON がパースできません:', e.message);
      process.exit(1);
    }
    console.log('[seed] 検証: GET で JSON を復元し、schemaVersion が lib/monitor-constants.js と一致しました');
  } catch (e) {
    console.error('[seed] Redis 書き込み失敗:', e.message);
    process.exit(1);
  }

  console.log('[seed] 書き込み完了');
  console.log(`[seed] MONITOR_SCHEMA_VERSION=${MONITOR_SCHEMA_VERSION}（lib/monitor-constants.js と monitor.js で共有）`);
  console.log(`[seed] Redis キー: ${key}`);
  console.log(`[seed] userId=${userId} sourceId=${sourceId} itemId=${itemId} hash=${hash}`);
  console.log(`[seed] 検索キーワード: ${entry.keyword}`);
  console.log('[seed] 次のコマンドで動作確認: node run-cli.mjs');
})();
