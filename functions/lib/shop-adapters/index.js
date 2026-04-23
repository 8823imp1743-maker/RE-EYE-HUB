import { RakutenAdapter } from './rakuten.js';
import { YahooAdapter }   from './yahoo.js';
import { filterNoise }    from '../noise-filter.js';

const REGISTRY = [
  new RakutenAdapter(),
  new YahooAdapter(),
];

export function getActiveAdapters() {
  return REGISTRY.filter((a) => a.isConfigured());
}

function isRunCli() {
  return process.env.RE_EYE_CLI === '1' || process.env.RE_EYE_CLI === 'true';
}

export async function searchAll(keyword, options = {}) {
  const adapters = getActiveAdapters();
  const activeIds = adapters.map((a) => a.id);
  // 本番 Vercel での「誰が生きているか」証明用（getActiveAdapters = isConfigured() 通過分のみ）
  console.log(
    '[AUDIT] Active Adapters: ' +
      (activeIds.length ? '[' + activeIds.join(', ') + ']' : '[]')
  );

  if (isRunCli() && adapters.length === 0) {
    console.log('[run-cli] 楽天・Yahoo の API キーが未設定のため、ショップ検索 API は呼び出しません');
  }

  const results = await Promise.allSettled(
    adapters.map(adapter => adapter.search(keyword, options))
  );

  const items  = [];
  const errors = [];
  const perAdapter = [];

  results.forEach((result, i) => {
    const shopName = adapters[i].name;
    const id = adapters[i].id;
    if (result.status === 'fulfilled') {
      const arr = result.value || [];
      perAdapter.push({ id, count: arr.length, ok: true });
      if (isRunCli()) {
        console.log(`[run-cli] ${shopName}: 取得成功（${arr.length}件ヒット）`);
      }
      items.push(...arr);
    } else {
      perAdapter.push({ id, count: 0, ok: false, err: result.reason?.message || 'Error' });
      const msg = `[${shopName}] ${result.reason?.message || 'Error'}`;
      errors.push(msg);
      console.error('[Reporting Officer] ' + msg);
      if (isRunCli()) {
        console.log(`[run-cli] ${shopName}: エラー — ${result.reason?.message || 'Error'}`);
      }
    }
  });
  console.log(
    '[AUDIT][searchAll] 1キーワードあたり合流(事後filterNoise前) raw=',
    items.length,
    'adapters=',
    JSON.stringify(perAdapter),
    'inKeyword=',
    String(keyword).slice(0, 180)
  );

  // ── 事後検閲：中古・オークション・禁止ドメインを全滅させる ──
  const cleanItems = filterNoise(items);
  if (items.length !== cleanItems.length) {
    console.log('[AUDIT][searchAll] filterNoise 除外', items.length - cleanItems.length, '件');
  }

  return { items: cleanItems, errors };
}

export function getAdapterInfo() {
  return REGISTRY.map(a => ({
    id:           a.id,
    name:         a.name,
    isConfigured: a.isConfigured(),
  }));
}