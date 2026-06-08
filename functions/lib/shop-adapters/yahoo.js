/**
 * Yahoo!ショッピングアダプター (サイズ除外検索・報告係搭載)
 */
import { ShopAdapter } from './base.js';
import { withRetry } from '../retry.js';
import { fetchWithTimeout } from '../http-fetch.js';
import { genresForKeyword } from '../user-size.js';

const API_BASE = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch';
const MALL_UA  = 'Mozilla/5.0 (compatible; RE-EYE-HUB/1.0; +https://re-eye-hub.web.app)';

/** Yahoo ジャンル: メンズシューズ / レディースシューズ */
const YAHOO_GENRE_MENS_SHOE = '2495';
const YAHOO_GENRE_WOMENS_SHOE = '2496';

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

function logMallEmptyResponse(adapterId, keyword, json, tag = '') {
  try {
    console.warn(
      `[mall-debug][${adapterId}] 0件${tag ? ` (${tag})` : ''} keyword=${JSON.stringify(String(keyword).slice(0, 120))} raw=`,
      JSON.stringify(json).slice(0, 1200)
    );
  } catch (_) {
    console.warn(`[mall-debug][${adapterId}] 0件 — レスポンスの stringify に失敗`);
  }
}

/**
 * 靴キーワード時の genre_category_id（OR 絞り込み）
 * @param {string} keyword
 * @param {string} [userGender] male | female | unknown
 */
function resolveYahooShoeGenreIds(keyword, userGender = 'unknown') {
  const { isShoe } = genresForKeyword(String(keyword || ''));
  if (!isShoe) return null;
  const g = String(userGender || '').toLowerCase();
  if (g === 'male') return YAHOO_GENRE_MENS_SHOE;
  if (g === 'female') return YAHOO_GENRE_WOMENS_SHOE;
  const k = String(keyword).toLowerCase();
  if (/レディース|ウィメンズ|women|wmns|女性|ガールズ|女の子/.test(k)) {
    return YAHOO_GENRE_WOMENS_SHOE;
  }
  if (/メンズ|men|男性|ボーイズ|男の子/.test(k)) {
    return YAHOO_GENRE_MENS_SHOE;
  }
  return `${YAHOO_GENRE_MENS_SHOE},${YAHOO_GENRE_WOMENS_SHOE}`;
}

function mapYahooHits(hits) {
  return (hits || []).map((item) => {
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
    const genreCategoryId =
      item.genreCategory?.id != null ? String(item.genreCategory.id) : undefined;
    const genreCategoryName =
      item.genreCategory?.name != null ? String(item.genreCategory.name).trim() : undefined;
    if (genreCategoryName) tags.push(genreCategoryName);
    const colorLabel = item.colorName || item.color || '';
    const description =
      typeof item.description === 'string' ? item.description.slice(0, 4000) : '';
    const headLine = typeof item.headLine === 'string' ? item.headLine : '';
    const ins = item.inStock;
    const inStock = ins === true || ins === 'true' || ins === 1 || ins === '1';

    return {
      sourceId:  'yahoo',
      itemId:    String(item.code || item.url || item.name),
      title:     item.name,
      brand:     brandName || '',
      price:     Number(item.price) || 0,
      available: inStock,
      url:       item.url,
      imageUrl:  item.image?.medium || '',
      shopName:  sellerName || 'Yahoo!ショッピング',
      sellerName: sellerName || undefined,
      checkedAt: Date.now(),
      colorLabel: colorLabel || undefined,
      tags:      tags.length ? tags : undefined,
      headLine:  headLine || undefined,
      description: description || undefined,
      genreCategoryId: genreCategoryId || undefined,
      genreCategoryName: genreCategoryName || undefined,
      yahooGenreId: genreCategoryId || undefined,
    };
  });
}

async function callYahooItemSearch(appId, params, label) {
  const requestUrl = `${API_BASE}?${params.toString()}`;
  console.log(`[mall-debug][yahoo] OUTBOUND GET (${label})`, maskMallRequestUrl(requestUrl));
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
    { label: `Yahoo!API:${label}`, maxRetries: 2, baseDelayMs: 400 }
  );
  return json;
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
      userGender = 'unknown',
      shoeSearchIntent = false,
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
    const genreIds = resolveYahooShoeGenreIds(refinedKeyword, userGender);
    const forceShoeGenre = shoeSearchIntent || !!genreIds;

    const strategies = forceShoeGenre && genreIds
      ? [
          { label: 'v3_genre_new', genre: genreIds, condition: 'new' },
          { label: 'v3_genre_any', genre: genreIds, condition: null },
        ]
      : [
          { label: 'v3_plain_new', genre: null, condition: 'new' },
          { label: 'v3_plain_any', genre: null, condition: null },
        ];

    let lastJson = null;
    for (const st of strategies) {
      const params = new URLSearchParams({
        appid:   appId,
        query:   refinedKeyword,
        results: String(nRes),
        start:   String(yahooStart),
        sort:    '+price',
      });
      if (st.genre) params.set('genre_category_id', st.genre);
      if (st.condition) params.set('condition', st.condition);

      try {
        const json = await callYahooItemSearch(appId, params, st.label);
        lastJson = json;
        if (json && (json.Error || json.error)) {
          console.error(
            `[AUDIT][yahoo] API 本文エラー (${st.label})`,
            JSON.stringify(json.Error || json.error).slice(0, 800)
          );
          continue;
        }
        const hits = json.hits || [];
        console.log(
          `[Reporting Officer] Yahooで ${hits.length} 件ヒット (${st.label})。`,
          hits.length === 0 && json.totalResultsAvailable != null
            ? `(totalResultsAvailable=${json.totalResultsAvailable})`
            : ''
        );
        if (hits.length > 0) return mapYahooHits(hits);
        if (hits.length === 0) logMallEmptyResponse('yahoo', refinedKeyword, json, st.label);
      } catch (e) {
        console.warn(`[yahoo] ${st.label} failed:`, e?.message || e);
      }
    }

    if (lastJson) logMallEmptyResponse('yahoo', refinedKeyword, lastJson, 'all_strategies');
    return [];
  }
}
