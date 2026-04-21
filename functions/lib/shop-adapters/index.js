import { RakutenAdapter } from './rakuten.js';
import { YahooAdapter }   from './yahoo.js';
import { filterNoise }    from '../noise-filter.js';

const REGISTRY = [
  new RakutenAdapter(),
  new YahooAdapter(),
];

export function getActiveAdapters() {
  return REGISTRY.filter(a => a.isConfigured());
}

function isRunCli() {
  return process.env.RE_EYE_CLI === '1' || process.env.RE_EYE_CLI === 'true';
}

export async function searchAll(keyword, options = {}) {
  const adapters = getActiveAdapters();

  const names = adapters.map(a => a.id).join(', ') || 'NONE';
  console.log('[Reporting Officer] Active adapters: ' + names);

  if (isRunCli() && adapters.length === 0) {
    console.log('[run-cli] 楽天・Yahoo の API キーが未設定のため、ショップ検索 API は呼び出されません');
  }

  const results = await Promise.allSettled(
    adapters.map(adapter => adapter.search(keyword, options))
  );

  const items  = [];
  const errors = [];

  results.forEach((result, i) => {
    const shopName = adapters[i].name;
    if (result.status === 'fulfilled') {
      const arr = result.value || [];
      if (isRunCli()) {
        console.log(`[run-cli] ${shopName}: 取得成功（${arr.length}件ヒット）`);
      }
      items.push(...arr);
    } else {
      const msg = `[${shopName}] ${result.reason?.message || 'Error'}`;
      errors.push(msg);
      console.error('[Reporting Officer] ' + msg);
      if (isRunCli()) {
        console.log(`[run-cli] ${shopName}: エラー — ${result.reason?.message || 'Error'}`);
      }
    }
  });

  // ── 事後検閲：中古・オークション・禁止ドメインを全滅させる ──
  const cleanItems = filterNoise(items);

  return { items: cleanItems, errors };
}

export function getAdapterInfo() {
  return REGISTRY.map(a => ({
    id:           a.id,
    name:         a.name,
    isConfigured: a.isConfigured(),
  }));
}