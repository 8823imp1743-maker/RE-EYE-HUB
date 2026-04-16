/**
 * 楽天市場アダプター (サイズ除外検索・報告係搭載)
 */
import { ShopAdapter } from './base.js';
import { withRetry } from '../retry.js';
import { RAKUTEN_NG_KEYWORD } from '../noise-filter.js';
import { extractModelNumbers } from '../cross-validator.js';

const API_BASE   = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';
const APP_ORIGIN = 'https://re-eye-hub.web.app';

export class RakutenAdapter extends ShopAdapter {
  get id() { return 'rakuten'; }
  get name() { return '楽天市場'; }

  isConfigured() {
    return !!process.env.RAKUTEN_APP_ID;
  }

  async search(keyword, options = {}) {
    const { maxResults = 20, inStockOnly = false } = options;

    // 🛠 検索ワードから「26.5cm」などのサイズ表記を消す（これが0件の原因）
    let refinedKeyword = keyword
      .replace(/[0-9]{2}(\.[0-9])?cm/g, '') 
      .replace(/国内正規品|メンズ|レディース|送料無料|新品|公式|ショップ|【.*?】|（.*?）/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 🚩 報告係：実際に何で検索してるかログに出す
    console.log(`[Reporting Officer] 楽天・改善ワード: "${refinedKeyword}" (サイズを除外しました)`);

    const applicationId  = (process.env.RAKUTEN_APP_ID || '').replace(/-/g, '');
    const affiliateId    = process.env.RAKUTEN_AFFILIATE_ID || '';

    const params = new URLSearchParams({
      applicationId,
      keyword: refinedKeyword,
      NGKeyword: RAKUTEN_NG_KEYWORD,
      hits:      String(Math.min(maxResults, 30)),
      sort:      '-updateTimestamp',
      ...(affiliateId ? { affiliateId } : {}),
      ...(inStockOnly ? { availability: '1' } : {}),
    });

    const json = await withRetry(
      () => fetch(`${API_BASE}?${params.toString()}`, {
        headers: {
          'Accept':  'application/json',
          'Referer': APP_ORIGIN + '/',
          'Origin':  APP_ORIGIN,
        },
      }),
      { label: '楽天API', maxRetries: 3, baseDelayMs: 2000 }
    );
    const items = (json.Items || []);
    console.log(`[Reporting Officer] 楽天で ${items.length} 件ヒット。`);

    return items.map(({ Item }) => {
      const title = Item.itemName || '';
      // 型番を抽出してフィールドに保持（横断バリデーターが後続で使用）
      const modelNumbers = extractModelNumbers(title);
      return {
        sourceId:     this.id,
        itemId:       String(Item.itemCode || Item.itemUrl || Item.itemName),
        title,
        price:        Number(Item.itemPrice) || 0,
        available:    Item.availability === 1,
        url:          Item.itemUrl,
        imageUrl:     Item.mediumImageUrls?.[0]?.imageUrl || '',
        shopName:     this.name,
        checkedAt:    Date.now(),
        // 型番（CW2288-111等） — 横断バリデーション用
        modelNumbers: modelNumbers.length > 0 ? modelNumbers : undefined,
      };
    });
  }
}