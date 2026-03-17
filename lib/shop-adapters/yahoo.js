/**
 * Yahoo!ショッピングアダプター
 * Yahoo Shopping Item Search API v3
 * https://developer.yahoo.co.jp/webapi/shopping/shopping/v3/itemsearch.html
 *
 * 必要な環境変数:
 *   YAHOO_APP_ID — Yahoo!デベロッパーネットワーク https://e.developer.yahoo.co.jp/ で取得（無料）
 */

import { ShopAdapter } from './base.js';

const API_BASE = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch';

export class YahooAdapter extends ShopAdapter {
  get id() { return 'yahoo'; }
  get name() { return 'Yahoo!ショッピング'; }

  isConfigured() {
    return !!process.env.YAHOO_APP_ID;
  }

  async search(keyword, options = {}) {
    const { maxResults = 20, inStockOnly = false } = options;

    const params = new URLSearchParams({
      appid:   process.env.YAHOO_APP_ID,
      query:   keyword,
      results: String(Math.min(maxResults, 50)), // Yahoo API上限50件
      sort:    '-score',
      ...(inStockOnly ? { in_stock: 'true' } : {}),
    });

    const res = await fetch(`${API_BASE}?${params.toString()}`, {
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`Yahoo Shopping API error: ${res.status}`);
    }

    const json = await res.json();
    const hits = json.hits || [];
    const checkedAt = Date.now();

    return hits.map(item => ({
      sourceId:  this.id,
      itemId:    String(item.code || item.url || item.name),
      title:     item.name,
      price:     Number(item.price) || 0,
      available: item.inStock === true,
      url:       item.url,
      imageUrl:  item.image?.medium || '',
      shopName:  this.name,
      checkedAt,
    }));
  }
}
