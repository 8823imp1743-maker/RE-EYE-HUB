/**
 * Yahoo!ショッピングアダプター (サイズ除外検索・報告係搭載)
 */
import { ShopAdapter } from './base.js';
import { withRetry } from '../retry.js';
import { fetchWithTimeout } from '../http-fetch.js';

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

    const cli = process.env.RE_EYE_CLI === '1' || process.env.RE_EYE_CLI === 'true';
    if (cli) {
      const q = refinedKeyword.slice(0, 80);
      console.log(`[run-cli] Yahoo!ショッピングの商品を検索中… 「${q}${refinedKeyword.length > 80 ? '…' : ''}」`);
    }

    const json = await withRetry(
      () => fetchWithTimeout(`${API_BASE}?${params.toString()}`, {}, 14000),
      { label: 'Yahoo!API', maxRetries: 2, baseDelayMs: 400 }
    );
    const hits = json.hits || [];
    console.log(`[Reporting Officer] Yahooで ${hits.length} 件ヒット。`);

    return hits.map(item => {
      const tags = [];
      const brandName = typeof item.brand === 'string' ? item.brand : item.brand?.name;
      if (brandName) tags.push(String(brandName));
      if (item.genreCategory?.name) tags.push(String(item.genreCategory.name));
      const colorLabel = item.colorName || item.color || '';
      const description =
        typeof item.description === 'string' ? item.description.slice(0, 4000) : '';
      const headLine = typeof item.headLine === 'string' ? item.headLine : '';
      return {
        sourceId:  this.id,
        itemId:    String(item.code || item.url || item.name),
        title:     item.name,
        price:     Number(item.price) || 0,
        available: item.inStock === true,
        url:       item.url,
        imageUrl:  item.image?.medium || '',
        shopName:  this.name,
        checkedAt: Date.now(),
        colorLabel: colorLabel || undefined,
        tags:      tags.length ? tags : undefined,
        /** バリエーション表記や型番が商品名以外に載ることが多い */
        headLine:  headLine || undefined,
        description: description || undefined,
      };
    });
  }
}