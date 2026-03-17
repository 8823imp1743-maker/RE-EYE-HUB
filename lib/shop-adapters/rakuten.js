/**
 * 楽天市場アダプター
 * Rakuten Ichiba Item Search API v20220601
 * https://webservice.rakuten.co.jp/documentation/ichiba-item-search
 *
 * 必要な環境変数:
 *   RAKUTEN_APP_ID — 楽天デベロッパーAPI https://webservice.rakuten.co.jp/ で取得（無料）
 */

import { ShopAdapter } from './base.js';

const API_BASE = 'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601';

export class RakutenAdapter extends ShopAdapter {
  get id() { return 'rakuten'; }
  get name() { return '楽天市場'; }

  isConfigured() {
    return !!process.env.RAKUTEN_APP_ID;
  }

  async search(keyword, options = {}) {
    const { maxResults = 20, inStockOnly = false } = options;

    const params = new URLSearchParams({
      applicationId: process.env.RAKUTEN_APP_ID,
      keyword,
      hits: String(Math.min(maxResults, 30)), // 楽天API上限30件
      sort: '-updateTimestamp',               // 更新新着順
      ...(inStockOnly ? { availability: '1' } : {}),
    });

    const res = await fetch(`${API_BASE}?${params.toString()}`, {
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`Rakuten API error: ${res.status}`);
    }

    const json = await res.json();
    const checkedAt = Date.now();

    return (json.Items || []).map(({ Item }) => ({
      sourceId:  this.id,
      itemId:    String(Item.itemCode || Item.itemUrl || Item.itemName),
      title:     Item.itemName,
      price:     Number(Item.itemPrice) || 0,
      available: Item.availability === 1,
      url:       Item.itemUrl,
      imageUrl:  Item.mediumImageUrls?.[0]?.imageUrl || '',
      shopName:  this.name,
      checkedAt,
    }));
  }
}
