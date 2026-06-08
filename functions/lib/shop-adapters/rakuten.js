/**
 * 楽天市場アダプター (サイズ除外検索・報告係搭載)
 */
import { ShopAdapter } from './base.js';
import { withRetry } from '../retry.js';
import { fetchWithTimeout } from '../http-fetch.js';
import { RAKUTEN_NG_KEYWORD } from '../noise-filter.js';
import { extractModelNumbers } from '../cross-validator.js';
import { genresForKeyword } from '../user-size.js';

const API_BASE   = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';
const APP_ORIGIN = 'https://re-eye-hub.web.app';
const MALL_UA    = 'Mozilla/5.0 (compatible; RE-EYE-HUB/1.0; +https://re-eye-hub.web.app)';

/** 楽天 App ID（Vercel 環境変数 RAKUTEN_APP_ID のみ） */
function resolveRakutenAppId() {
  return (process.env.RAKUTEN_APP_ID || '').trim();
}

function resolveRakutenAccessKey() {
  return (process.env.RAKUTEN_ACCESS_KEY || process.env.RAKUTEN_API_KEY || '').trim();
}

/** 新API(UUID)はハイフン保持・旧数値IDのみハイフン除去 */
function normalizeRakutenApplicationId(raw) {
  const id = String(raw || '').trim();
  if (!id) return '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
  return id.replace(/-/g, '');
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

const CM_TOKEN_RE = /[0-9]{1,2}(?:\.[0-9])?\s*(?:cm|㎝)\b/gi;

function isCmPreserveToken(token) {
  return /^\d{1,2}(?:\.\d)?\s*cm$/i.test(String(token || '').trim());
}

/** 楽天 Ichiba の keyword インデックスは cm 非対応が多い → 靴検索では API から cm を除去 */
function stripCmTokensFromMallKeyword(kw) {
  return String(kw || '')
    .replace(CM_TOKEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

export class RakutenAdapter extends ShopAdapter {
  get id() { return 'rakuten'; }
  get name() { return '楽天市場'; }

  isConfigured() {
    // affiliateId は不要。商品検索に必要なのは applicationId + accessKey のみ
    return !!(resolveRakutenAppId() && resolveRakutenAccessKey());
  }

  async search(keyword, options = {}) {
    const rawEnvAppId = process.env.RAKUTEN_APP_ID;
    const envAppIdPresent = !!String(rawEnvAppId || '').trim();
    const appId = resolveRakutenAppId();
    const appIdPresent = !!String(appId || '').trim();

    const {
      maxResults = 20,
      mallPreserveTokens = [],
      page: mallPage = 1,
      shoeSearchIntent = false,
    } = options;
    let preserve = Array.isArray(mallPreserveTokens)
      ? mallPreserveTokens.map((t) => String(t || '').trim()).filter(Boolean)
      : [];

    let refinedKeyword = String(keyword ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    const shoeIntent =
      shoeSearchIntent === true ||
      (shoeSearchIntent !== false && genresForKeyword(refinedKeyword).isShoe);

    // 靴: cm は PDP/ゲート側のみ。楽天 API keyword に 26.5cm を混ぜるとヒット 0 になりやすい（Yahoo は genre 絞りで救済される）
    if (shoeIntent) {
      preserve = preserve.filter((t) => !isCmPreserveToken(t));
      refinedKeyword = stripCmTokensFromMallKeyword(refinedKeyword);
    }

    if (preserve.length) {
      const anchor = preserve.join(' ').trim();
      refinedKeyword = `${anchor} ${refinedKeyword}`.replace(/\s+/g, ' ').trim();
    }

    const preserveNote = preserve.length ? `（ユーザー固着: ${preserve.join(', ')}）` : '（クエリそのまま）';
    console.log(
      `[Reporting Officer] 楽天・改善ワード: "${refinedKeyword}" ${preserveNote}` +
        (shoeIntent ? ' [shoe:cm stripped for API]' : '')
    );

    const applicationId = normalizeRakutenApplicationId(appId);
    const accessKey = resolveRakutenAccessKey();
    const affiliateId = (process.env.RAKUTEN_AFFILIATE_ID || '').trim();

    console.log(
      '[mall-debug][rakuten] KEY_CHECK envAppId=',
      envAppIdPresent,
      'resolvedAppId=',
      appIdPresent,
      'accessKey=',
      !!accessKey,
      'affiliateId=',
      !!affiliateId
    );

    if (!applicationId) {
      console.warn('[rakuten] applicationId missing → skip calling Rakuten API');
      return [];
    }
    if (!accessKey) {
      console.warn('[rakuten] accessKey missing → skip calling Rakuten API (affiliateId の有無は無関係)');
      return [];
    }

    const pageNum = Math.max(1, Math.min(100, Number(mallPage) || 1));
    const params = new URLSearchParams({
      applicationId,
      accessKey,
      keyword: refinedKeyword,
      hits: String(Math.min(maxResults, 30)),
      page: String(pageNum),
      sort: '-updateTimestamp',
      format: 'json',
      ...(affiliateId ? { affiliateId } : {}),
    });
    if (RAKUTEN_NG_KEYWORD) params.set('NGKeyword', RAKUTEN_NG_KEYWORD);

    const cli = process.env.RE_EYE_CLI === '1' || process.env.RE_EYE_CLI === 'true';
    if (cli) {
      const q = refinedKeyword.slice(0, 80);
      console.log(`[run-cli] 楽天の商品を検索中… 「${q}${refinedKeyword.length > 80 ? '…' : ''}」`);
    }

    const requestUrl = `${API_BASE}?${params.toString()}`;
    const kwForLog = String(params.get('keyword') || '').slice(0, 220);
    console.log('[mall-debug][rakuten] OUTBOUND GET', maskMallRequestUrl(requestUrl));
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
              Accept: 'application/json',
              'User-Agent': MALL_UA,
              Referer: APP_ORIGIN + '/',
              Origin: APP_ORIGIN,
              Authorization: `Bearer ${accessKey}`,
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
        JSON.stringify({ error: json.error, Errors: json.Errors, Message: json.Message, error_description: json.error_description }).slice(0, 800)
      );
    }
    const items = (json.Items || []);
    console.log(
      `[Reporting Officer] 楽天で ${items.length} 件ヒット。`,
      items.length === 0 ? '（0件: クエリ不調・認証不足・上記errorのいずれか）' : ''
    );
    if (items.length === 0) logMallEmptyResponse('rakuten', refinedKeyword, json);

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
        // brand: 楽天 API は直接の brand フィールドを持たないため空文字で初期化。
        // enrichItemStructure() が canonical_id 生成時に利用する（sku があれば空でも可）。
        brand:        '',
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