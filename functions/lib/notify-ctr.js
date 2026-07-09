import { stablePercentBucket } from './notify-plan-policy.js';

/**
 * A/B/C（ユーザーIDベースで固定）。
 * variant: 'A'|'B'|'C'
 */
export function ctrVariant(userId, salt = 'ctr-v1') {
  const bucket = stablePercentBucket(`${salt}:${userId}`);
  if (bucket < 33) return 'A';
  if (bucket < 66) return 'B';
  return 'C';
}

/** タイトル先頭から短いブランド／キーワード（テンプレ④用・長文禁止） */
function pickLeadingBrandKeyword(s) {
  const t = String(s || '').trim();
  const lat = t.match(/^([A-Za-z][\w&.+\-]{1,28})/);
  if (lat) return lat[1];
  const jp = t.match(/^[\u3000-\u9FFF々〆〤ー]{2,12}/u);
  if (jp) return jp[0];
  return '';
}

function detectScarceTitle(text) {
  return /(?:残り|わずか|ラスト|僅か|sold\s*out|品切れ|完売|残\d)/iu.test(String(text || ''));
}

function normalizeVariant(v) {
  return v === 'A' || v === 'B' || v === 'C' ? v : 'C';
}

/**
 * CTR 短文テンプレ（【サイズ】＋【状況】＋【行動】／オークション・長文・価格のみは載せない）。
 * stockHint: scarce | unknown | ok
 *
 * @param {{
 *   itemTitle?: string,
 *   keywordLabel?: string,
 *   shoeRaw?: string|number,
 *   clothingAlpha?: string,
 *   variant?: string,
 *   stockHint?: string,
 *   price?: number,
 *   listPrice?: number,
 * }} opts
 */
export function buildStockMonitorCtr(opts) {
  const itemTitle = String(opts.itemTitle || '').trim();
  const keywordFallback = String(opts.keywordLabel || '商品').trim();
  const variant = normalizeVariant(opts.variant);

  const shoeRawRaw =
    opts.shoeRaw != null && String(opts.shoeRaw).trim() !== ''
      ? String(opts.shoeRaw).trim()
      : '';
  const clothA =
    opts.clothingAlpha != null && String(opts.clothingAlpha).trim() !== ''
      ? String(opts.clothingAlpha).trim().toUpperCase()
      : '';
  const sizePart = shoeRawRaw ? `${shoeRawRaw}cm` : clothA ? `サイズ${clothA}` : '';

  /** @type {'scarce'|'unknown'|'ok'} */
  let hint =
    opts.stockHint === 'scarce' ||
    opts.stockHint === 'unknown' ||
    opts.stockHint === 'ok'
      ? opts.stockHint
      : 'ok';
  if (hint === 'ok' && detectScarceTitle(itemTitle || keywordFallback)) {
    hint = 'scarce';
  }

  const price = typeof opts.price === 'number' ? opts.price : NaN;
  const listPrice = typeof opts.listPrice === 'number' ? opts.listPrice : NaN;
  const cheapVsList =
    Number.isFinite(price) &&
    Number.isFinite(listPrice) &&
    listPrice > 0 &&
    price <= listPrice * 0.95;

  /** @type {'urgent'|'cheap'|'default'} */
  let mode = 'default';
  if (hint === 'scarce') mode = 'urgent';
  else if (cheapVsList) mode = 'cheap';

  const brand = pickLeadingBrandKeyword(itemTitle || keywordFallback);

  let title;

  /**
   * ① サイズ cm 入荷｜今すぐ確認
   * ② 残りわずか｜急げ
   * ⑤ 【cm】今だけ在庫あり
   * ③ 再入荷｜前回は即完売
   * ④ Nike 26.5cm 入荷｜人気モデル
   */
  if (mode === 'urgent') {
    if (variant === 'A') {
      title = sizePart ? `${sizePart} 残りわずか｜急げ` : `残りわずか｜急げ`;
    } else if (variant === 'B') {
      title = shoeRawRaw
        ? `【${shoeRawRaw}cm】今だけ在庫あり`
        : `【在庫】今だけ確認`;
    } else {
      title = sizePart
        ? `${sizePart} 再入荷｜前回は即完売`
        : `再入荷｜前回は即完売`;
    }
  } else if (mode === 'cheap') {
    title = sizePart ? `${sizePart} 入荷｜今すぐ確認` : `入荷｜今すぐ確認`;
  } else if (variant === 'B' && brand) {
    title = (
      sizePart ? `${brand} ${sizePart} 入荷｜人気モデル` : `${brand} 入荷｜人気モデル`
    ).slice(0, 52);
  } else if (variant === 'C') {
    title = sizePart
      ? `${sizePart} 再入荷｜前回は即完売`
      : `再入荷｜確認`;
  } else {
    title = sizePart ? `${sizePart} 入荷｜今すぐ確認` : `入荷｜今すぐ確認`;
  }

  title = title.replace(/\s+/g, ' ').trim().slice(0, 52);

  const shopName = String(opts.shopName || opts.shop || '').trim();
  const productShort = (itemTitle || keywordFallback).replace(/\s+/g, ' ').trim().slice(0, 48);
  let message = sizePart
    ? `${sizePart} を開く`.slice(0, 120)
    : `${keywordFallback.slice(0, 28)} を確認`.slice(0, 120);
  if (shopName && productShort) {
    message = `${shopName}｜${productShort}`.slice(0, 120);
  } else if (productShort) {
    message = productShort.slice(0, 120);
  }

  const templateId = `st_${variant}_${mode}`;

  return { title: title || '入荷｜確認', message, templateId };
}
