/**
 * オークション相場チェッカー
 * Yahoo!オークション API でキーワードに一致する出品の最低現在価格を取得する
 *
 * 必要環境変数: YAHOO_APP_ID
 */

import { fetchWithTimeout } from './http-fetch.js';

const API_BASE = 'https://auctions.yahooapis.jp/AuctionWebService/V2/json/search';

/**
 * キーワードに一致するヤフオク出品の最低現在価格（円）を返す
 * 取得できない場合は null
 * @param {string} keyword
 * @returns {Promise<number|null>}
 */
export async function getAuctionMinPrice(keyword) {
  if (!process.env.YAHOO_APP_ID) return null;

  const params = new URLSearchParams({
    appid:  process.env.YAHOO_APP_ID,
    query:  keyword,
    output: 'json',
    hits:   '20',
    sort:   'cbids',  // 入札数順
    order:  'a',      // 昇順（安い順）
    status: 'open',   // 出品中のみ
  });

  try {
    const res = await fetchWithTimeout(`${API_BASE}?${params}`, {}, 12000);
    if (!res.ok) {
      console.warn(`[auction-checker] Yahoo Auctions API ${res.status}: ${keyword}`);
      return null;
    }

    const json = await res.json();
    const raw   = json.ResultSet?.Result?.Item;
    const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);

    if (items.length === 0) return null;

    const prices = items
      .map(i => Number(i.CurrentPrice || i.Price || 0))
      .filter(p => p > 0);

    return prices.length > 0 ? Math.min(...prices) : null;
  } catch(e) {
    console.error('[auction-checker] 取得失敗:', e.message);
    return null;
  }
}
