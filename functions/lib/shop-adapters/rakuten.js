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
    const {
      maxResults = 20,
      inStockOnly = false,
      mallPreserveTokens = [],
      page: mallPage = 1,
    } = options;
    const preserve = Array.isArray(mallPreserveTokens)
      ? mallPreserveTokens.map((t) => String(t || '').trim()).filter(Boolean)
      : [];

    // ヒット拡大のため cm を落とす → 続けて mallPreserveTokens をクエリ先頭に固定（検索の主眼＝ユーザーの鍵）
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
    console.log(`[Reporting Officer] 楽天・改善ワード: "${refinedKeyword}" ${preserveNote}`);

    // applicationId: 環境変数のハイフンは API が受け付ける形式に合わせて除去
    const applicationId = (process.env.RAKUTEN_APP_ID || '').trim().replace(/-/g, '');
    const accessKey = (process.env.RAKUTEN_ACCESS_KEY || '').trim();
    const affiliateId = (process.env.RAKUTEN_AFFILIATE_ID || '').trim();

    if (!applicationId || !accessKey) {
      throw new Error(
        '楽天 API: RAKUTEN_APP_ID と RAKUTEN_ACCESS_KEY を .env に設定してください（開発者ポータルのアプリ一覧で確認）'
      );
    }

    const pageNum = Math.max(1, Math.min(100, Number(mallPage) || 1));
    const params = new URLSearchParams({
      applicationId,
      accessKey,
      keyword: refinedKeyword,
      NGKeyword: RAKUTEN_NG_KEYWORD,
      hits: String(Math.min(maxResults, 30)),
      page: String(pageNum),
      sort: '-updateTimestamp',
      ...(affiliateId ? { affiliateId } : {}),
      ...(inStockOnly ? { availability: '1' } : {}),
    });

    const cli = process.env.RE_EYE_CLI === '1' || process.env.RE_EYE_CLI === 'true';
    if (cli) {
      const q = refinedKeyword.slice(0, 80);
      console.log(`[run-cli] 楽天の商品を検索中… 「${q}${refinedKeyword.length > 80 ? '…' : ''}」`);
    }

    const requestUrl = `${API_BASE}?${params.toString()}`;
    const kwForLog = String(params.get('keyword') || '').slice(0, 220);
    console.log(
      '[AUDIT][rakuten] OUTBOUND HTTPS GET host=openapi.rakuten.co.jp path=/ichibams/.../Search keywordQuery=' +
        JSON.stringify(kwForLog) +
        ' (sizeワード含むか=' +
        /\d+(\.\d+)?\s*cm/i.test(kwForLog) +
        ')'
    );
    const json = await withRetry(
      () =>
        fetchWithTimeout(
          requestUrl,
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
    // 200 でも body に error / Message が載る場合がある（このとき Items は空に近い）
    if (json && (json.error != null || json.Errors)) {
      console.error(
        '[AUDIT][rakuten] API 本文エラー（HTTP 200 でも要確認）',
        JSON.stringify({ error: json.error, Errors: json.Errors, Message: json.Message }).slice(0, 500)
      );
    }
    const items = (json.Items || []);
    console.log(
      `[Reporting Officer] 楽天で ${items.length} 件ヒット。`,
      items.length === 0 ? '（0件: クエリ不調・在庫なし・上記errorのいずれか。keyword はログ参照）' : ''
    );

    return items.map(({ Item }) => {
      const title = Item.itemName || '';
      const sellerName = Item.shopName != null ? String(Item.shopName).trim() : '';
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
      // Ichiba Search の availability: 1=販売可が基本。文字列 "1" や数値揺れに対応。
      // 親SKUで返る行は「全サイズ売切れ」でも 0 になり得る（バリエーション在庫は PDP のみ）→ 厳密一致だけだと誤判定しやすい。
      const rawAv = Item.availability;
      const inStock =
        rawAv === 1 ||
        rawAv === '1' ||
        Number(rawAv) === 1;

      return {
        sourceId:     this.id,
        itemId:       String(Item.itemCode || Item.itemUrl || Item.itemName),
        title,
        price:        Number(Item.itemPrice) || 0,
        available:    inStock,
        url:          Item.itemUrl,
        imageUrl:     Item.mediumImageUrls?.[0]?.imageUrl || '',
        shopName:     sellerName || this.name,
        sellerName:   sellerName || undefined,
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