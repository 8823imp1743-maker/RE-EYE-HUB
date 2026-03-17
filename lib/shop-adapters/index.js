/**
 * ショップアダプター レジストリ
 *
 * 新ショップ追加手順:
 *   1. lib/shop-adapters/<shopname>.js を作成し ShopAdapter を継承
 *   2. このファイルの REGISTRY に追加するだけ
 *   3. isConfigured() が false のアダプターは自動的にスキップされる
 */

import { RakutenAdapter } from './rakuten.js';
import { YahooAdapter }   from './yahoo.js';
import { AmazonAdapter }  from './amazon.js';

/** 全アダプターのシングルトンインスタンス */
const REGISTRY = [
  new RakutenAdapter(),
  new YahooAdapter(),
  new AmazonAdapter(),
];

/**
 * 環境変数が揃っている（稼働可能な）アダプターのみ返す
 * @returns {ShopAdapter[]}
 */
export function getActiveAdapters() {
  return REGISTRY.filter(a => a.isConfigured());
}

/**
 * 全アクティブアダプターで並列検索し、結果を統合して返す
 * エラーが出たアダプターはスキップしてログ出力する（1つが落ちても全滅しない）
 *
 * @param {string} keyword
 * @param {{ maxResults?: number, inStockOnly?: boolean }} options
 * @returns {Promise<{ items: NormalizedItem[], errors: string[] }>}
 */
export async function searchAll(keyword, options = {}) {
  const adapters = getActiveAdapters();

  const results = await Promise.allSettled(
    adapters.map(adapter => adapter.search(keyword, options))
  );

  const items  = [];
  const errors = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else {
      const msg = `[${adapters[i].name}] ${result.reason?.message || 'Unknown error'}`;
      errors.push(msg);
      console.error(msg);
    }
  });

  return { items, errors };
}

/**
 * アダプター一覧情報（フロントエンド向け）
 */
export function getAdapterInfo() {
  return REGISTRY.map(a => ({
    id:           a.id,
    name:         a.name,
    type:         a.type,
    isConfigured: a.isConfigured(),
  }));
}
