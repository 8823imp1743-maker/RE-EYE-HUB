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
    const {
      maxResults = 20,
      inStockOnly = false,
      mallPreserveTokens = [],
      yahooStart: startParam = 1,
    } = options;
    const yahooStart = Math.max(1, Math.min(1000, Number(startParam) || 1));
    const preserve = Array.isArray(mallPreserveTokens)
      ? mallPreserveTokens.map((t) => String(t || '').trim()).filter(Boolean)
      : [];

    let refinedKeyword = keyword
      .replace(/[0-9]{2}(\.[0-9])?cm/g, '')
      .replace(/国内正規品|メンズ|レディース|送料無料|新品|公式|ショップ|【.*?】|（.*?）/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (preserve.length) {
      const anchor = preserve.join(' ').trim();
      refinedKeyword = `${anchor} ${refinedKeyword}`.replace(/\s+/g, ' ').trim();
    }

    const preserveNote = preserve.length ? `（ユーザー固着: ${preserve.join(', ')}）` : '（サイズを除外しました）';
    console.log(`[Reporting Officer] Yahoo・改善ワード: "${refinedKeyword}" ${preserveNote}`);

    const nRes = Math.min(maxResults, 50);
    const params = new URLSearchParams({
      appid:     process.env.YAHOO_APP_ID,
      query:     refinedKeyword,
      results:   String(nRes),
      start:     String(yahooStart),
      sort:      '+price',
      condition: 'new',
      ...(inStockOnly ? { in_stock: 'true' } : {}),
    });

    const cli = process.env.RE_EYE_CLI === '1' || process.env.RE_EYE_CLI === 'true';
    if (cli) {
      const q = refinedKeyword.slice(0, 80);
      console.log(`[run-cli] Yahoo!ショッピングの商品を検索中… 「${q}${refinedKeyword.length > 80 ? '…' : ''}」`);
    }

    const requestUrl = `${API_BASE}?${params.toString()}`;
    const qForLog = String(params.get('query') || '').slice(0, 220);
    console.log(
      '[AUDIT][yahoo] OUTBOUND HTTPS GET host=shopping.yahooapis.jp path=/V3/itemSearch query=' +
        JSON.stringify(qForLog) +
        ' (sizeワード含むか=' +
        /\d+(\.\d+)?\s*cm/i.test(qForLog) +
        ')'
    );
    const json = await withRetry(
      () => fetchWithTimeout(requestUrl, {}, 14000),
      { label: 'Yahoo!API', maxRetries: 2, baseDelayMs: 400 }
    );
    const hits = json.hits || [];
    console.log(`[Reporting Officer] Yahooで ${hits.length} 件ヒット。`);

    return hits.map((item) => {
      const sellerName =
        (item.seller && (item.seller.name || item.seller.sellerName)) != null
          ? String(item.seller.name || item.seller.sellerName).trim()
          : item.storeName
            ? String(item.storeName).trim()
            : item.store && item.store.name
              ? String(item.store.name).trim()
              : '';
      const tags = [];
      const brandName = typeof item.brand === 'string' ? item.brand : item.brand?.name;
      if (brandName) tags.push(String(brandName));
      if (item.genreCategory?.name) tags.push(String(item.genreCategory.name));
      const colorLabel = item.colorName || item.color || '';
      const description =
        typeof item.description === 'string' ? item.description.slice(0, 4000) : '';
      const headLine = typeof item.headLine === 'string' ? item.headLine : '';
      const ins = item.inStock;
      const inStock = ins === true || ins === 'true' || ins === 1 || ins === '1';

      return {
        sourceId:  this.id,
        itemId:    String(item.code || item.url || item.name),
        title:     item.name,
        price:     Number(item.price) || 0,
        available: inStock,
        url:       item.url,
        imageUrl:  item.image?.medium || '',
        shopName:  sellerName || this.name,
        sellerName: sellerName || undefined,
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