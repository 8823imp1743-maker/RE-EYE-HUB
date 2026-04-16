/**
 * ユーザーサイズ設定をキーワードに自動注入するヘルパー
 *
 * 使用箇所:
 *   api/search.js  — 検索直前にサイズをクエリに付加
 *   api/monitor.js — 見守り登録時のキーワードにサイズ付加
 */

import { getRedis } from './redis.js';

// フロントの buildSizeAwareKeyword と同じ判定リスト（サーバー側コピー）
const SHOE_KW  = ['スニーカー','シューズ','ブーツ','サンダル','靴','shoe','sneaker','boots'];
const CLOTH_KW = ['ジャケット','コート','ニット','シャツ','パンツ','スカート','服','アウター',
                  'tシャツ','ワンピース','トップス','デニム','パーカー'];

/**
 * Redis から userId の設定を取得する。
 * 失敗時は null を返す（サイズ注入なしでそのまま続行）。
 */
async function getUserSettings(userId) {
  if (!userId) return null;
  try {
    const r = getRedis();
    const raw = await r.get(`user:settings:${userId}`);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch(e) {
    console.warn('[user-size] Redis 取得失敗:', e.message);
    return null;
  }
}

/**
 * ユーザー設定のサイズを keyword に自動注入して返す。
 *
 * @param {string} userId
 * @param {string} keyword  元のキーワード（例: "ナイキ エアフォース"）
 * @param {boolean} forChild  子供用サイズを使うか
 * @returns {Promise<string>}  注入済みキーワード（例: "ナイキ エアフォース 27.5cm"）
 */
export async function getUserSizeKeyword(userId, keyword, forChild = false) {
  const settings = await getUserSettings(userId);
  if (!settings) return keyword;

  const kl = keyword.toLowerCase();
  const isShoe  = SHOE_KW.some(w  => kl.includes(w.toLowerCase()));
  const isCloth = CLOTH_KW.some(w => kl.includes(w.toLowerCase()));

  let kw = keyword;

  if (forChild) {
    const cg = settings.childGender === 'girl' ? '女の子'
             : settings.childGender === 'boy'  ? '男の子' : '';
    if (cg)  kw += ' ' + cg;
    if (isCloth && settings.childClothSize) kw += ' ' + settings.childClothSize;
    if (isShoe  && settings.childShoeSize)  kw += ' ' + settings.childShoeSize + 'cm';
  } else {
    if (isCloth && settings.clothSize) kw += ' ' + settings.clothSize;
    if (isShoe  && settings.shoeSize)  kw += ' ' + settings.shoeSize + 'cm';
  }

  return kw.trim();
}

/**
 * タイトルからサイズ数値を抽出する（入荷判定の厳格化用）。
 *
 * @param {string} text  商品タイトルまたはキーワード
 * @returns {number|null}  サイズ数値（cm）または null
 */
export function extractSizeCm(text) {
  if (!text) return null;
  // "27.5cm" / "27.5 cm" / "27.5" + 前後に cm
  const m = text.match(/(\d{2,3}(?:\.\d)?)\s*cm/i);
  if (m) return parseFloat(m[1]);
  // "26号" などはスキップ（服サイズは文字列比較で行う）
  return null;
}

/**
 * 商品タイトルとキーワードのサイズが一致するか検証する。
 *
 * 両方にサイズ情報がある場合のみ比較。片方にない場合は通過（誤検知より見逃しの方がマシ）。
 * 許容誤差: ±0.5cm（27.5 と 27.0 は別サイズとして扱う）
 *
 * @param {string} itemTitle   商品タイトル
 * @param {string} keyword     見守りキーワード（例: "ナイキ 27.5cm"）
 * @returns {boolean}  true=通知OK / false=サイズ不一致なのでスキップ
 */
export function validateSizeMatch(itemTitle, keyword) {
  const itemSize = extractSizeCm(itemTitle);
  const kwSize   = extractSizeCm(keyword);

  // どちらかにサイズ情報がなければ通過
  if (itemSize === null || kwSize === null) return true;

  // ±0.5cm 以内のみ一致
  return Math.abs(itemSize - kwSize) <= 0.5;
}
