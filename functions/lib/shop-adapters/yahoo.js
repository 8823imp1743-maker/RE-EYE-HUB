/**
 * Yahoo!ショッピングアダプター (サイズ除外検索・報告係搭載)
 */
import { ShopAdapter } from './base.js';
import { withRetry } from '../retry.js';

const API_BASE = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch';

export class YahooAdapter extends ShopAdapter {
  get id() { return 'yahoo'; }
  get name() { return 'Yahoo!ショッピング'; }

  isConfigured() {
    return !!process.env.YAHOO_APP_ID;
  }

  async search(keyword, options = {}) {
    const { maxResults = 20, inStockOnly = false } = options;

    // 🛠 検索ワードから「26.5cm」などのサイズ表記を消す
    let refinedKeyword = keyword
      .replace(/[0-9]{2}(\.[0-9])?cm/g, '') 
      .replace(/国内正規品|メンズ|レディース|送料無料|新品|公式|ショップ|【.*?】|（.*?）/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`[Reporting Officer] Yahoo・改善ワード: "${refinedKeyword}" (サイズを除外しました)`);

    const params = new URLSearchParams({
      appid:     process.env.YAHOO_APP_ID,
      query:     refinedKeyword,
      results:   String(Math.min(maxResults, 50)),
      sort:      '+price',
      condition: 'new',
      ...(inStockOnly ? { in_stock: 'true' } : {}),
    });

    const json = await withRetry(
      () => fetch(`${API_BASE}?${params.toString()}`, {
        headers: { 'Accept': 'application/json' },
      }),
      { label: 'Yahoo!API', maxRetries: 3, baseDelayMs: 2000 }
    );
    const hits = json.hits || [];
    console.log(`[Reporting Officer] Yahooで ${hits.length} 件ヒット。`);

    return hits.map(item => ({
      sourceId:  this.id,
      itemId:    String(item.code || item.url || item.name),
      title:     item.name,
      price:     Number(item.price) || 0,
      available: item.inStock === true,
      url:       item.url,
      imageUrl:  item.image?.medium || '',
      shopName:  this.name,
      checkedAt: Date.now(),
    }));
  }
}