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

export async function searchAll(keyword, options = {}) {
  const adapters = getActiveAdapters();

  const names = adapters.map(a => a.id).join(', ') || 'NONE';
  console.log('[Reporting Officer] Active adapters: ' + names);

  const results = await Promise.allSettled(
    adapters.map(adapter => adapter.search(keyword, options))
  );

  const items  = [];
  const errors = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else {
      const msg = `[${adapters[i].name}] ${result.reason?.message || 'Error'}`;
      errors.push(msg);
      console.error('[Reporting Officer] ' + msg);
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