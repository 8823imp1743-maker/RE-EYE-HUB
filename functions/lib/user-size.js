/**
 * ユーザーサイズ設定をキーワードに自動注入するヘルパー
 *
 * 使用箇所:
 *   api/search.js  — 検索直前にサイズをクエリに付加
 *   api/monitor.js — 見守り登録時のキーワードにサイズ付加
 */

import { getRedis } from './redis.js';
import { sanitizeStoredUserSettings, userSettingsKey, sanitizeUserId } from './user-settings.js';

// フロントの buildSizeAwareKeyword と同じ判定リスト（サーバー側コピー）
const SHOE_KW  = ['スニーカー','シューズ','ブーツ','サンダル','靴','shoe','sneaker','boots'];
const CLOTH_KW = ['ジャケット','コート','ニット','シャツ','パンツ','スカート','服','アウター',
                  'tシャツ','ワンピース','トップス','デニム','パーカー'];
/** 手袋・小物系：キーワード一致時は服の SML ではなく glovesSml / childGlovesSml を注入 */
const GLOVE_ACCESSORY_KW = [
  '手袋', 'グローブ', '革手袋', 'ミトン', '軍手', '指なし', 'glove', 'gloves', 'mitten', 'mittens',
];
/** CW2288-111 / HQ7001-001 のようなスポーツ品番だけの入力でも靴サイズ注入する（品番検索とプロファイルの整合） */
const SHOE_SKU_HINT_RE = /\b[A-Z]{2,4}\d{3,5}-\d{2,4}\b/i;
/** public/index.html の buildSizeAwareKeyword と同型（サーバ単体でも cm 注入できるようにする） */
const SNEAKER_MODEL_HINT_RE =
  /エアマックス|エア\s*マックス|air\s*max|max\s*90|ジョーダン|jordan|ダンク|dunk|フォース|air\s*force|アディダス|adidas|ニューバランス|new\s*balance|ゲル|gel-lyte|アシックス/i;

/**
 * レガシー shoeSize / 新 user-settings の shoeCm から注入用 cm 数値を得る。
 * @param {object} settings
 * @returns {number|null}
 */
function pickAdultShoeCmForInject(settings) {
  if (!settings) return null;
  if (settings.shoeSize != null && settings.shoeSize !== '') {
    const n = Number(String(settings.shoeSize).replace(/cm$/i, '').trim());
    if (Number.isFinite(n) && n >= 20 && n <= 35) return Math.round(n * 10) / 10;
  }
  if (typeof settings.shoeCm === 'number' && Number.isFinite(settings.shoeCm)) {
    const r = Math.round(settings.shoeCm * 10) / 10;
    if (r >= 20 && r <= 35) return r;
  }
  if (settings.shoeCm != null && settings.shoeCm !== '') {
    const n = Number(settings.shoeCm);
    if (Number.isFinite(n)) {
      const r = Math.round(n * 10) / 10;
      if (r >= 20 && r <= 35) return r;
    }
  }
  return null;
}

/**
 * レガシー clothSize / 新 API clothing
 * @param {object} settings
 * @returns {string|null}
 */
function pickAdultClothSizeForInject(settings) {
  if (!settings) return null;
  const c = settings.clothSize || settings.clothing;
  if (c == null || c === '') return null;
  return String(c).trim();
}

/**
 * 手袋・小物用 S/M/L（服の clothing とは別キー）
 * @param {object} settings
 * @param {boolean} forChild
 * @returns {string|null}
 */
function pickGlovesSmlForInject(settings, forChild) {
  if (!settings) return null;
  if (forChild) {
    if (settings.childGlovesSml == null || settings.childGlovesSml === '') return null;
    const t = String(settings.childGlovesSml).trim().toUpperCase();
    return t === 'S' || t === 'M' || t === 'L' ? t : null;
  }
  if (settings.glovesSml == null || settings.glovesSml === '') return null;
  const t = String(settings.glovesSml).trim().toUpperCase();
  return t === 'S' || t === 'M' || t === 'L' ? t : null;
}

/**
 * Redis から userId の設定を取得する（**1 userId ＝ 1 キー**。他利用者の箱と合流しない; 子フィールドも同じ箱の中だけ）。
 * 大人向け必須キーは `sanitizeStoredUserSettings` 済み。子ども用・UI 専用のレガシー（shoeSize 文字列等）は **生オブジェクトを併合**し落とさない。
 */
async function getUserSettings(userId) {
  const id = typeof userId === 'string' ? sanitizeUserId(userId) : null;
  if (!id) return null;
  try {
    const r = getRedis();
    const raw = await r.get(userSettingsKey(id));
    if (!raw) return null;
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    const safe = sanitizeStoredUserSettings(typeof raw === 'string' ? raw : JSON.stringify(obj));
    if (!safe) return null;
    return {
      ...obj,
      schemaVersion: safe.schemaVersion,
      updatedAt: safe.updatedAt,
      shoeCm: safe.shoeCm,
      clothing: safe.clothing,
      numeric: safe.numeric,
      prefecture: safe.prefecture,
      glovesSml: safe.glovesSml,
      childGender: safe.childGender,
      childClothSize: safe.childClothSize,
      childShoeSize: safe.childShoeSize,
      childGlovesSml: safe.childGlovesSml,
    };
  } catch (e) {
    console.warn('[user-size] Redis 取得失敗:', e.message);
    return null;
  }
}

/**
 * Redis から userId の設定を1回だけ取得する（呼び出し側で複数キーワードに使い回す）。
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function loadUserSettings(userId) {
  return getUserSettings(userId);
}

/**
 * 事後フィルター用：ユーザー設定の靴 cm 数値（生文字列。hasSizeInTitleUniversal に渡す raw）
 * @param {object|null} settings
 * @param {boolean} forChild
 * @returns {string|null}
 */
export function getUserShoeCmRawForPostFilter(settings, forChild = false) {
  if (!settings) return null;
  if (forChild) {
    if (settings.childShoeSize == null || settings.childShoeSize === '') return null;
    const cs = String(settings.childShoeSize).trim().replace(/cm$/i, '');
    if (!cs) return null;
    return /^\d+(\.\d+)?$/.test(cs) ? cs : null;
  }
  const cm = pickAdultShoeCmForInject(settings);
  if (cm == null) return null;
  return Number.isInteger(cm) ? String(cm) : String(cm);
}

export function genresForKeyword(keyword) {
  const kw = keyword || '';
  const kl = kw.toLowerCase();
  const likelySneaker = SNEAKER_MODEL_HINT_RE.test(kw);
  const isShoe =
    SHOE_KW.some(w => kl.includes(w.toLowerCase())) ||
    SHOE_SKU_HINT_RE.test(kw) ||
    likelySneaker;
  const isCloth = CLOTH_KW.some(w => kl.includes(w.toLowerCase()));
  const isAccessoryGlove = GLOVE_ACCESSORY_KW.some(w => kl.includes(String(w).toLowerCase()));
  return { isShoe, isCloth, isAccessoryGlove };
}

function keywordAlreadyHasClothingToken(kw, cloth) {
  const esc = String(cloth).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(kw);
}

/**
 * 取得済み settings に基づき、靴・服ジャンルなら設定サイズを機械的にクエリへ合成する。
 * （Redis は呼ばない。同一 user の複数キーワードは loadUserSettings 1 回 + 本関数で回す）
 *
 * @param {object|null} settings
 * @param {string} keyword
 * @param {boolean} forChild
 * @returns {string}
 */
export function applyUserSizesToKeywordFromSettings(settings, keyword, forChild = false) {
  if (!keyword) return '';
  let kw = String(keyword).trim();
  if (!settings) return kw;

  const { isShoe, isCloth, isAccessoryGlove } = genresForKeyword(kw);

  if (forChild) {
    const cg = settings.childGender === 'girl' ? '女の子'
             : settings.childGender === 'boy'  ? '男の子' : '';
    if (cg) kw = `${kw} ${cg}`.trim();
    if (isAccessoryGlove) {
      const g = pickGlovesSmlForInject(settings, true);
      if (g && !keywordAlreadyHasClothingToken(kw, g)) kw = `${kw} ${g}`.trim();
    } else {
      if (isCloth && settings.childClothSize) {
        const c = String(settings.childClothSize).trim();
        if (c && !keywordAlreadyHasClothingToken(kw, c)) kw = `${kw} ${c}`.trim();
      }
    }
    if (isShoe && settings.childShoeSize != null && settings.childShoeSize !== '') {
      const cs = String(settings.childShoeSize).trim();
      const tok = `${cs}cm`;
      if (cs && !kw.toLowerCase().includes(tok.toLowerCase())) kw = `${kw} ${tok}`.trim();
    }
    return kw.trim();
  }

  if (isAccessoryGlove) {
    const g = pickGlovesSmlForInject(settings, false);
    if (g && !keywordAlreadyHasClothingToken(kw, g)) kw = `${kw} ${g}`.trim();
  } else {
    const cloth = pickAdultClothSizeForInject(settings);
    if (isCloth && cloth && !keywordAlreadyHasClothingToken(kw, cloth)) {
      kw = `${kw} ${cloth}`.trim();
    }
  }

  if (isShoe) {
    const cm = pickAdultShoeCmForInject(settings);
    if (cm != null) {
      const s = Number.isInteger(cm) ? String(cm) : cm.toFixed(1);
      const token = `${s}cm`;
      if (!kw.toLowerCase().includes(token.toLowerCase())) {
        kw = `${kw} ${token}`.trim();
      }
    }
  }

  return kw.trim();
}

/**
 * Redis 1 回 + 全キーワードへサイズ合成（scout 等のバッチ用）
 * @param {string} userId
 * @param {string[]} keywords
 * @param {boolean} forChild
 * @returns {Promise<string[]>}
 */
export async function getUserSizeKeywordsForUser(userId, keywords, forChild = false) {
  if (!userId || !Array.isArray(keywords)) return (keywords || []).map((k) => (typeof k === 'string' ? k : String(k || '')));
  const settings = await getUserSettings(userId);
  if (!settings) return keywords.map((k) => (typeof k === 'string' ? k : String(k || '')));
  return keywords.flatMap((k) =>
    expandShoeInboundQuerySeeds(settings, typeof k === 'string' ? k : String(k || ''), forChild)
  );
}

/**
 * 靴ジャンルかつ設定に cm があるとき、入荷・抽選に直結する複合クエリを複数生成する。
 * @param {object|null} settings
 * @param {string} keyword
 * @param {boolean} forChild
 * @returns {string[]}
 */
export function expandShoeInboundQuerySeeds(settings, keyword, forChild = false) {
  const base = applyUserSizesToKeywordFromSettings(settings || {}, keyword, forChild);
  if (!keyword || !String(keyword).trim()) return base ? [base] : [];
  if (!settings) return [base];

  const { isShoe } = genresForKeyword(keyword);
  const hasChildShoe =
    forChild &&
    settings &&
    settings.childShoeSize != null &&
    String(settings.childShoeSize).trim() !== '';
  const adultShoeForExpand = forChild ? null : pickAdultShoeCmForInject(settings);
  /** 子: 子の靴ありのみ拡張。大人: 大人の靴 cm のみ参照（子の数値は見ない） */
  const canExpandShoe = isShoe && (forChild ? hasChildShoe : adultShoeForExpand != null);
  if (!canExpandShoe) return [base];

  const out = new Set([base]);
  for (const tail of ['在庫', '抽選']) {
    if (!base.includes(tail)) out.add(`${base} ${tail}`.trim());
  }
  return [...out];
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
  return applyUserSizesToKeywordFromSettings(settings, keyword, forChild);
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

/**
 * 楽天/Yahoo アダプタがクエリから cm 等を削る前に、必ず API クエリへ戻す「ユーザー固有情報の鍵」。
 * （search.js で注入した 26.5cm 等が refinedKeyword で消えないようにする）
 *
 * @param {object|null} settings
 * @param {string} keyword  ユーザーが入力したベースキーワード（注入前・ジャンル判定用）
 * @param {boolean} forChild
 * @returns {string[]}
 */
export function getUserMallPreserveTokens(settings, keyword, forChild = false) {
  if (!settings || !keyword) return [];
  const kw = String(keyword).trim();
  const { isShoe, isCloth, isAccessoryGlove } = genresForKeyword(kw);
  const tokens = [];

  if (forChild) {
    if (isAccessoryGlove) {
      const g = pickGlovesSmlForInject(settings, true);
      if (g) tokens.push(g);
    } else if (isCloth && settings.childClothSize) {
      const c = String(settings.childClothSize).trim();
      if (c) tokens.push(c);
    }
    if (isShoe && settings.childShoeSize != null && settings.childShoeSize !== '') {
      const cs = String(settings.childShoeSize).trim();
      if (cs) tokens.push(/cm/i.test(cs) ? cs : `${cs}cm`);
    }
    return [...new Set(tokens.filter(Boolean))];
  }

  if (isAccessoryGlove) {
    const g = pickGlovesSmlForInject(settings, false);
    if (g) tokens.push(g);
  } else {
    const cloth = pickAdultClothSizeForInject(settings);
    if (isCloth && cloth) tokens.push(cloth);
  }

  if (isShoe) {
    const cm = pickAdultShoeCmForInject(settings);
    if (cm != null) {
      const s = Number.isInteger(cm) ? String(cm) : cm.toFixed(1);
      tokens.push(`${s}cm`);
    }
  }

  return [...new Set(tokens.filter(Boolean))];
}

/** RSS 記事に「在庫系シグナル」とユーザー設定サイズが同時に出たときの温度上乗せ（トレンド探索用） */
const RSS_STOCK_SIG =
  /在庫|入荷|再入荷|再販|販売開始|発売|抽選|予約|リストック|restock|サイズ\s*[:：]?\s*あり|全サイズ/i;

/**
 * 子の靴文字列（Redis）から在庫ボーナス用の数値 cm を得る（大人の pickAdult とは分離）
 */
function pickChildShoeCmForBonus(settings) {
  if (!settings || settings.childShoeSize == null || settings.childShoeSize === '') return null;
  const t = String(settings.childShoeSize).replace(/cm/gi, '').trim();
  if (!t) return null;
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

/**
 * @param {object|null} settings
 * @param {{ title?: string, description?: string }} item
 * @param {boolean} [forChild]  true: 子の服・子の靴の一致のみ上乗せ。false: 大人のみ（混線禁止）
 * @returns {number}
 */
export function scoreInventoryNewsBonusForUser(settings, item, forChild = false) {
  if (!settings || !item) return 0;
  const hay = `${item.title || ''}\n${item.description || ''}`;
  if (!hay.trim() || !RSS_STOCK_SIG.test(hay)) return 0;

  let bonus = 0;
  if (forChild) {
    const ccm = pickChildShoeCmForBonus(settings);
    if (ccm != null) {
      const s = Number.isInteger(ccm) ? String(ccm) : ccm.toFixed(1);
      const esc = s.replace('.', '\\.');
      const cmRe = new RegExp(
        `(?:\\b|[^0-9])${esc}\\s*cm|(?:\\b|[^0-9])${esc}(?=\\s*(cm|センチ|mm))`,
        'i'
      );
      if (cmRe.test(hay)) bonus += 900;
    }
    const cCloth = settings.childClothSize != null ? String(settings.childClothSize).trim() : '';
    if (cCloth) {
      const esc = cCloth.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reCloth = new RegExp(`(?:\\b|/|\\(|（)${esc}(?:\\b|/|\\)|）)`, 'i');
      if (reCloth.test(hay)) bonus += 600;
    }
  } else {
    const cm = pickAdultShoeCmForInject(settings);
    if (cm != null) {
      const s = Number.isInteger(cm) ? String(cm) : cm.toFixed(1);
      const esc = s.replace('.', '\\.');
      const cmRe = new RegExp(
        `(?:\\b|[^0-9])${esc}\\s*cm|(?:\\b|[^0-9])${esc}(?=\\s*(cm|センチ|mm))`,
        'i'
      );
      if (cmRe.test(hay)) bonus += 900;
    }
    const cloth = pickAdultClothSizeForInject(settings);
    if (cloth) {
      const esc = String(cloth).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reCloth = new RegExp(`(?:\\b|/|\\(|（)${esc}(?:\\b|/|\\)|）)`, 'i');
      if (reCloth.test(hay)) bonus += 600;
    }
  }

  return bonus;
}
