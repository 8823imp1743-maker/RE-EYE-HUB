/**
 * Yahoo!ショッピングアダプター (サイズ除外検索・報告係搭載)
 */
import { ShopAdapter } from './base.js';
import { withRetry } from '../retry.js';
import { fetchWithTimeout } from '../http-fetch.js';

const API_BASE = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch';
const MALL_UA  = 'Mozilla/5.0 (compatible; RE-EYE-HUB/1.0; +https://re-eye-hub.web.app)';

function resolveYahooAppId() {
  return (process.env.YAHOO_APP_ID || '').trim();
}

function maskMallRequestUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    ['applicationId', 'accessKey', 'affiliateId', 'appid'].forEach((k) => {
      if (u.searchParams.has(k)) u.searchParams.set(k, '***');
    });
    return u.toString();
  } catch (_) {
    return String(urlStr).replace(
      /(applicationId|accessKey|affiliateId|appid)=([^&]+)/gi,
      '$1=***'
    );
  }
}

function logMallEmptyResponse(adapterId, keyword, json) {
  try {
    console.warn(
      `[mall-debug][${adapterId}] 0件 keyword=${JSON.stringify(String(keyword).slice(0, 120))} raw=`,
      JSON.stringify(json).slice(0, 1200)
    );
  } catch (_) {
    console.warn(`[mall-debug][${adapterId}] 0件 — レスポンスの stringify に失敗`);
  }
}

export class YahooAdapter extends ShopAdapter {
  get id() { return 'yahoo'; }
  get name() { return 'Yahoo!ショッピング'; }

  isConfigured() {
    return !!resolveYahooAppId();
  }

  async search(keyword, options = {}) {
    const {
      maxResults = 20,
      mallPreserveTokens = [],
      yahooStart: startParam = 1,
    } = options;
    const yahooStart = Math.max(1, Math.min(1000, Number(startParam) || 1));
    const preserve = Array.isArray(mallPreserveTokens)
      ? mallPreserveTokens.map((t) => String(t || '').trim()).filter(Boolean)
      : [];

    let refinedKeyword = String(keyword ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    if (preserve.length) {
      const anchor = preserve.join(' ').trim();
      refinedKeyword = `${anchor} ${refinedKeyword}`.replace(/\s+/g, ' ').trim();
    }

    const preserveNote = preserve.length ? `（ユーザー固着: ${preserve.join(', ')}）` : '（クエリそのまま）';
    console.log(`[Reporting Officer] Yahoo・改善ワード: "${refinedKeyword}" ${preserveNote}`);

    const appId = resolveYahooAppId();
    console.log('[mall-debug][yahoo] KEY_CHECK appId=', !!appId);
    if (!appId) {
      console.warn('[yahoo] YAHOO_APP_ID missing → skip calling Yahoo API');
      return [];
    }

    const nRes = Math.min(maxResults, 50);
    const params = new URLSearchParams({
      appid:     appId,
      query:     refinedKeyword,
      results:   String(nRes),
      start:     String(yahooStart),
      sort:      '+price',
      condition: 'new',
    });

    const cli = process.env.RE_EYE_CLI === '1' || process.env.RE_EYE_CLI === 'true';
    if (cli) {
      const q = refinedKeyword.slice(0, 80);
      console.log(`[run-cli] Yahoo!ショッピングの商品を検索中… 「${q}${refinedKeyword.length > 80 ? '…' : ''}」`);
    }

    const requestUrl = `${API_BASE}?${params.toString()}`;
    const qForLog = String(params.get('query') || '').slice(0, 220);
    console.log('[mall-debug][yahoo] OUTBOUND GET', maskMallRequestUrl(requestUrl));
    console.log(
      '[AUDIT][yahoo] OUTBOUND HTTPS GET host=shopping.yahooapis.jp path=/V3/itemSearch query=' +
        JSON.stringify(qForLog) +
        ' (sizeワード含むか=' +
        /\d+(\.\d+)?\s*cm/i.test(qForLog) +
        ')'
    );
    const json = await withRetry(
      () =>
        fetchWithTimeout(
          requestUrl,
          {
            headers: {
              Accept: 'application/json',
              'User-Agent': MALL_UA,
            },
          },
          14000
        ),
      { label: 'Yahoo!API', maxRetries: 2, baseDelayMs: 400 }
    );
    if (json && (json.Error || json.error)) {
      console.error(
        '[AUDIT][yahoo] API 本文エラー',
        JSON.stringify(json.Error || json.error).slice(0, 800)
      );
    }
    const hits = json.hits || [];
    console.log(
      `[Reporting Officer] Yahooで ${hits.length} 件ヒット。`,
      hits.length === 0 && json.totalResultsAvailable != null
        ? `(totalResultsAvailable=${json.totalResultsAvailable})`
        : ''
    );
    if (hits.length === 0) logMallEmptyResponse('yahoo', refinedKeyword, json);

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
        // brand: Yahoo API の brand フィールドをそのまま引き継ぐ。
        // enrichItemStructure() が canonical_id 生成時に normalizeSku() で正規化する。
        brand:     brandName || '',
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