import { RakutenAdapter }      from './rakuten.js';
import { YahooAdapter }        from './yahoo.js';
import { filterNoise }         from '../noise-filter.js';
import { enrichItemStructure } from '../serp-item-rule.js';

const REGISTRY = [
  new RakutenAdapter(),
  new YahooAdapter(),
];

export function getActiveAdapters() {
  // 新品救済の網羅性を最優先。設定未完のアダプターも含めて並列に回す（各アダプター側で未設定は空配列にする）
  return [...REGISTRY];
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
  const noiseDropped = Math.max(0, items.length - cleanItems.length);
  if (items.length !== cleanItems.length) {
    console.log('[AUDIT][searchAll] filterNoise 除外', noiseDropped, '件');
  }

<<<<<<< HEAD
  // ── adapter normalize: matcher に渡す前に共通構造化フィールドを確定する ──
  // brand / sku / skuAll / size / sizeInfo / color / canonical_id / source を保証する。
  // matcher (serpItemMatchesRule) は _enriched 済みの item のみを受け取る前提。
  cleanItems.forEach(enrichItemStructure);

  return { items: cleanItems, errors };
=======
  return {
    items: cleanItems,
    errors,
    rejectReasonSummary: {
      noiseExcluded: noiseDropped,
      marketRaw: items.length,
    },
  };
>>>>>>> 5cd0cd18d44d8972bc0f36c1caefc506e3d91796
}

export function getAdapterInfo() {
  return REGISTRY.map(a => ({
    id:           a.id,
    name:         a.name,
    isConfigured: a.isConfigured(),
  }));
}