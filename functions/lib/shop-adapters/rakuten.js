/**
 * 楽天市場アダプター (サイズ除外検索・報告係搭載)
 */
import { ShopAdapter } from './base.js';
import { withRetry } from '../retry.js';
import { fetchWithTimeout } from '../http-fetch.js';
import { RAKUTEN_NG_KEYWORD } from '../noise-filter.js';
import { extractModelNumbers } from '../cross-validator.js';

const API_BASE   = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';
const APP_ORIGIN = 'https://re-eye-hub.web.app';

export class RakutenAdapter extends ShopAdapter {
  get id() { return 'rakuten'; }
  get name() { return '楽天市場'; }

  isConfigured() {
    const appId = (process.env.RAKUTEN_APP_ID || '').trim();
    const accessKey = (process.env.RAKUTEN_ACCESS_KEY || '').trim();
    // 楽天開発者ポータル発行の App ID + Access Key（2026 年以降の API は両方必須）
    return !!(appId && accessKey);
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

    // applicationId: 環境変数のハイフンは API が受け付ける形式に合わせて除去
    const applicationId = (process.env.RAKUTEN_APP_ID || '').trim().replace(/-/g, '');
    const accessKey = (process.env.RAKUTEN_ACCESS_KEY || '').trim();
    const affiliateId = (process.env.RAKUTEN_AFFILIATE_ID || '').trim();

    if (!applicationId || !accessKey) {
      throw new Error(
        '楽天 API: RAKUTEN_APP_ID と RAKUTEN_ACCESS_KEY を .env に設定してください（開発者ポータルのアプリ一覧で確認）'
      );
    }

    const params = new URLSearchParams({
      applicationId,
      accessKey,
      keyword: refinedKeyword,
      NGKeyword: RAKUTEN_NG_KEYWORD,
      hits: String(Math.min(maxResults, 30)),
      sort: '-updateTimestamp',
      ...(affiliateId ? { affiliateId } : {}),
      ...(inStockOnly ? { availability: '1' } : {}),
    });

    const cli = process.env.RE_EYE_CLI === '1' || process.env.RE_EYE_CLI === 'true';
    if (cli) {
      const q = refinedKeyword.slice(0, 80);
      console.log(`[run-cli] 楽天の商品を検索中… 「${q}${refinedKeyword.length > 80 ? '…' : ''}」`);
    }

    const json = await withRetry(
      () =>
        fetchWithTimeout(
          `${API_BASE}?${params.toString()}`,
          {
            headers: {
              Referer: APP_ORIGIN + '/',
              Origin: APP_ORIGIN,
            },
          },
          14000
        ),
      { label: '楽天API', maxRetries: 2, baseDelayMs: 400 }
    );
    const items = (json.Items || []);
    console.log(`[Reporting Officer] 楽天で ${items.length} 件ヒット。`);

    return items.map(({ Item }) => {
      const title = Item.itemName || '';
      const modelNumbers = extractModelNumbers(title);
      const tagList = Item.tagList || [];
      const tags = tagList.map(t => t.tagName || t.name || '').filter(Boolean);
      let colorLabel = '';
      if (Item.colorName) colorLabel = String(Item.colorName);
      else if (tags.length) {
        const colorish = tags.find(t =>
          /色|カラー|color|ホワイト|ブラック|ネイビー|レッド|ブルー|白|黒|赤|青/i.test(t)
        );
        if (colorish) colorLabel = colorish;
      }
      const catchcopy = Item.catchcopy != null ? String(Item.catchcopy) : '';
      const itemCaption = Item.itemCaption != null ? String(Item.itemCaption) : '';
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
        colorLabel,
        tags:         tags.length ? tags : undefined,
        modelNumbers: modelNumbers.length > 0 ? modelNumbers : undefined,
        catchcopy:    catchcopy ? catchcopy.slice(0, 2000) : undefined,
        itemCaption:  itemCaption ? itemCaption.slice(0, 4000) : undefined,
      };
    });
  }
}