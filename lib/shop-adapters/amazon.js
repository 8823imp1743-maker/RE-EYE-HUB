/**
 * Amazon アダプター
 * Amazon Product Advertising API (PA-API) 5.0
 * https://webservices.amazon.co.jp/paapi5/documentation/
 *
 * 必要な環境変数:
 *   AMAZON_ACCESS_KEY   — IAMアクセスキー
 *   AMAZON_SECRET_KEY   — IAMシークレットキー
 *   AMAZON_PARTNER_TAG  — アソシエイトタグ（例: yourtag-22）
 *
 * 取得手順:
 *   1. https://affiliate.amazon.co.jp/ でアソシエイト登録（無料）
 *   2. 180日以内に3件以上の購買紹介実績を達成すると本番アクセス付与
 *   3. PA-API 認証情報は https://affiliate.amazon.co.jp/ > ツール > PA-API より取得
 *
 * リクエスト署名: AWS Signature Version 4 (HMAC-SHA256)
 */

import { createHmac, createHash } from 'crypto';
import { ShopAdapter } from './base.js';

const HOST    = 'webservices.amazon.co.jp';
const REGION  = 'us-east-1'; // PA-API は us-east-1 固定
const SERVICE = 'ProductAdvertisingAPI';
const PATH    = '/paapi5/searchitems';
const TARGET  = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems';

// AWS Sig V4 署名ヘルパー
function hmac(key, data, encoding = undefined) {
  return createHmac('sha256', key).update(data, 'utf8').digest(encoding);
}
function hash(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate    = hmac('AWS4' + secretKey, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  return kSigning;
}

export class AmazonAdapter extends ShopAdapter {
  get id() { return 'amazon'; }
  get name() { return 'Amazon'; }

  isConfigured() {
    return !!(
      process.env.AMAZON_ACCESS_KEY &&
      process.env.AMAZON_SECRET_KEY &&
      process.env.AMAZON_PARTNER_TAG
    );
  }

  async search(keyword, options = {}) {
    const { maxResults = 10 } = options;

    const payload = JSON.stringify({
      Keywords:    keyword,
      PartnerTag:  process.env.AMAZON_PARTNER_TAG,
      PartnerType: 'Associates',
      Marketplace: 'www.amazon.co.jp',
      Resources: [
        'ItemInfo.Title',
        'Offers.Listings.Price',
        'Offers.Listings.Availability.Type',
        'Images.Primary.Medium',
      ],
      SearchIndex: 'All',
      ItemCount:   Math.min(maxResults, 10), // PA-API 上限10件
    });

    // 署名に必要な日時を生成
    const now       = new Date();
    const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = hash(payload);

    // 署名対象ヘッダー（アルファベット順）
    const headers = {
      'content-encoding': 'amz-1.0',
      'content-type':     'application/json; charset=utf-8',
      'host':             HOST,
      'x-amz-date':       amzDate,
      'x-amz-target':     TARGET,
    };
    const signedHeaderKeys = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort()
      .map(k => `${k}:${headers[k]}\n`).join('');

    // Step 1: 正規リクエスト
    const canonicalRequest = [
      'POST',
      PATH,
      '',
      canonicalHeaders,
      signedHeaderKeys,
      payloadHash,
    ].join('\n');

    // Step 2: 署名文字列
    const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      hash(canonicalRequest),
    ].join('\n');

    // Step 3: 署名
    const signingKey = getSignatureKey(
      process.env.AMAZON_SECRET_KEY, dateStamp, REGION, SERVICE
    );
    const signature = hmac(signingKey, stringToSign, 'hex');

    // Step 4: Authorization ヘッダ
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${process.env.AMAZON_ACCESS_KEY}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaderKeys}, Signature=${signature}`;

    const res = await fetch(`https://${HOST}${PATH}`, {
      method: 'POST',
      headers: { ...headers, Authorization: authorization },
      body:    payload,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Amazon PA-API error: ${res.status} ${err}`);
    }

    const json     = await res.json();
    const items    = json.SearchResult?.Items || [];
    const checkedAt = Date.now();

    return items.map(item => {
      const listing = item.Offers?.Listings?.[0];
      const availType = listing?.Availability?.Type || '';
      return {
        sourceId:  this.id,
        itemId:    item.ASIN,
        title:     item.ItemInfo?.Title?.DisplayValue || '',
        price:     Number(listing?.Price?.Amount) || 0,
        available: availType === 'Now',
        url:       `https://www.amazon.co.jp/dp/${item.ASIN}?tag=${process.env.AMAZON_PARTNER_TAG}`,
        imageUrl:  item.Images?.Primary?.Medium?.URL || '',
        shopName:  this.name,
        checkedAt,
      };
    });
  }
}
