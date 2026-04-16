/**
 * ブランド名正規化モジュール
 * 省略形・略称 → 正式名称に変換し、検索精度を向上させる
 */

const BRAND_MAP = {
  // ── ラグジュアリー ──
  'ヴィトン': 'ルイ ヴィトン',
  'ルイヴィトン': 'ルイ ヴィトン',
  'LV': 'ルイ ヴィトン',
  'lv': 'ルイ ヴィトン',
  'シャネル': 'CHANEL',
  'グッチ': 'GUCCI',
  'エルメス': 'HERMES',
  'バーキン': 'HERMES バーキン',
  'ケリー': 'HERMES ケリー',
  'プラダ': 'PRADA',
  'バレンシアガ': 'Balenciaga',
  'セリーヌ': 'CELINE',
  'ジバンシィ': 'GIVENCHY',
  'ジバンシー': 'GIVENCHY',
  'フェンディ': 'FENDI',
  'ロエベ': 'LOEWE',
  'ボッテガ': 'Bottega Veneta',
  'ボッテガヴェネタ': 'Bottega Veneta',
  'マルジェラ': 'Maison Margiela',
  'ヴェルサーチ': 'VERSACE',
  'ベルサーチ': 'VERSACE',
  'バレンチノ': 'VALENTINO',
  'バレンティノ': 'VALENTINO',
  'モンクレール': 'MONCLER',
  'デュベティカ': 'DUVETICA',
  'バーバリー': 'BURBERRY',
  'コーチ': 'COACH',
  'ケイトスペード': 'kate spade',
  'トリーバーチ': 'TORY BURCH',
  'マイケルコース': 'Michael Kors',
  'MK': 'Michael Kors',
  // ── スニーカー・スポーツ ──
  'ナイキ': 'NIKE',
  'アディダス': 'adidas',
  'リーボック': 'Reebok',
  'プーマ': 'PUMA',
  'バンズ': 'Vans',
  'コンバース': 'CONVERSE',
  'ニューバランス': 'New Balance',
  'NB': 'New Balance',
  'nb': 'New Balance',
  'アシックス': 'ASICS',
  'オニツカ': 'Onitsuka Tiger',
  'エアフォース': 'Air Force 1',
  'AF1': 'Air Force 1',
  'ジョーダン': 'Air Jordan',
  'AJ1': 'Air Jordan 1',
  'イエジー': 'Yeezy',
  'ダンク': 'Nike Dunk',
  // ── アパレル ──
  'ユニクロ': 'UNIQLO',
  'ノースフェイス': 'THE NORTH FACE',
  'TNF': 'THE NORTH FACE',
  'シュプリーム': 'Supreme',
  'オフホワイト': 'Off-White',
  'ストーンアイランド': 'Stone Island',
  'パタゴニア': 'Patagonia',
  'アークテリクス': 'Arc\'teryx',
  'モンベル': 'mont-bell',
  'ザノースフェイス': 'THE NORTH FACE',
  // ── ゲーム・玩具 ──
  'ポケモン': 'ポケットモンスター',
  'ニンテンドー': 'Nintendo',
  'プレステ': 'PlayStation',
  'PS5': 'PlayStation 5',
  'PS4': 'PlayStation 4',
  'スイッチ': 'Nintendo Switch',
  'スイッチ2': 'Nintendo Switch 2',
  // ── 時計 ──
  'ロレックス': 'ROLEX',
  'オメガ': 'OMEGA',
  'カルティエ': 'Cartier',
  'パテックフィリップ': 'Patek Philippe',
  'ウブロ': 'HUBLOT',
  'タグホイヤー': 'TAG Heuer',
  'アップルウォッチ': 'Apple Watch',
  // ── 家電・テック ──
  'アップル': 'Apple',
  'アイフォン': 'iPhone',
  'マック': 'MacBook',
  'エアポッズ': 'AirPods',
  'ソニー': 'SONY',
};

/**
 * 入力キーワードに含まれるブランド省略形を正式名称に変換する
 * @param {string} keyword
 * @returns {string} normalized keyword
 */
export function normalizeBrand(keyword) {
  if (!keyword) return keyword;
  let result = keyword.trim();

  // 完全一致（キーワード全体がブランド略称）
  if (BRAND_MAP[result]) return BRAND_MAP[result];

  // 部分一致（複合キーワードの一部が略称に一致）
  for (const [abbr, full] of Object.entries(BRAND_MAP)) {
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('(^|[\\s　])' + escaped + '([\\s　]|$)', 'i');
    if (regex.test(result)) {
      result = result.replace(regex, `$1${full}$2`).trim();
      break;
    }
  }

  return result;
}

/**
 * 元のキーワードと正規化後の両方を返す（検索精度向上のため両方検索）
 * @param {string} keyword
 * @returns {string[]} 検索に使うキーワード一覧（重複除去済み）
 */
export function getSearchKeywords(keyword) {
  const normalized = normalizeBrand(keyword);
  if (normalized !== keyword) return [keyword, normalized];
  return [keyword];
}

/**
 * ブランド名のみの検索（商品特定なし）かどうかを判定する
 * ブランド略称・正式名称と完全一致 → true（検索を許可しない）
 * ブランド名 + 商品名/型番の複合キーワード → false（検索許可）
 *
 * @param {string} keyword
 * @returns {boolean}
 */
export function isBrandOnly(keyword) {
  if (!keyword) return false;
  const trimmed = keyword.trim();
  const lower   = trimmed.toLowerCase();

  // BRAND_MAP のキー（省略形・略称）と完全一致
  for (const key of Object.keys(BRAND_MAP)) {
    if (key.toLowerCase() === lower) return true;
  }

  // BRAND_MAP のバリュー（正式名称）と完全一致
  // 正規化後の結果がバリューと完全一致する場合も含む（例: "ROLEX", "NIKE"）
  const normalized = normalizeBrand(trimmed);
  const normLower  = normalized.toLowerCase();
  for (const val of Object.values(BRAND_MAP)) {
    if (val.toLowerCase() === lower)     return true;
    if (val.toLowerCase() === normLower) return true;
  }

  return false;
}
