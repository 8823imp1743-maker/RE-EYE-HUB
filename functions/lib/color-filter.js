/**
 * 色フィルター — 「ピンクを探しているのにデニムが来た」を永久に消す
 *
 * 哲学:
 *   キーワードに色が含まれている = ユーザーのこだわりは「その色だけ」。
 *   タイトルに色が存在しない結果は、タイトルが何であれノイズ。
 *   1件残らずシュレッダーにかける。
 *
 * 動作原則（冷徹版）:
 *   - キーワードから色ワードを抽出
 *   - 抽出された色ワードが「すべて」タイトルに含まれていれば通過
 *   - 1色でも欠けていれば即廃棄
 *   - 色ワードがキーワードに存在しない場合はフィルタースキップ（条件なし通過）
 */

// ── 日本語色ワード ────────────────────────────────────────────────────────────
const JP_COLORS = [
  'ピンク', 'ホワイト', 'ブラック', 'レッド', 'ブルー', 'グリーン', 'イエロー',
  'パープル', 'オレンジ', 'ベージュ', 'グレー', 'ネイビー', 'ブラウン',
  'シルバー', 'ゴールド', 'アイボリー', 'クリーム', 'ライトブルー', 'スカイブルー',
  'ダークブルー', 'ライトグレー', 'チャコール', 'ワイン', 'バーガンディ',
  'カーキ', 'オリーブ', 'ライム', 'コーラル', 'サーモン', 'ラベンダー',
  'ミント', 'ターコイズ', 'エクルー', 'サンド', 'マスタード', 'アクア',
  'インディゴ', 'ロイヤルブルー', 'スレート',
  // 漢字・ひらがな系
  '白', '黒', '赤', '青', '緑', '黄', '紫',
  // 日常語（辞書ギャップ補完）
  '水色', '茶色', '桃色', 'ライトグリーン', 'ダークグリーン',
];

// ── 英語色ワード（小文字で比較）──────────────────────────────────────────────
const EN_COLORS = [
  'pink', 'white', 'black', 'red', 'blue', 'green', 'yellow', 'purple',
  'orange', 'beige', 'grey', 'gray', 'navy', 'brown', 'silver', 'gold',
  'ivory', 'cream', 'coral', 'salmon', 'lavender', 'mint', 'turquoise',
  'charcoal', 'tan', 'mustard', 'burgundy', 'khaki', 'olive', 'lime',
  'aqua', 'indigo', 'slate',
  // ブランド固有色（よく使われるもの）
  'celeste', 'teal', 'jade', 'sage', 'mauve', 'taupe', 'ecru',
];

// ── 日英色対照マップ ─────────────────────────────────────────────────────────
// キーワードに「ピンク」とあっても公式タイトルに "Pink" とある場合に対応する。
// 逆方向（EN→JP）も同様。両方向で一致判定する。
const COLOR_CROSS_MAP = {
  // JP → EN
  'ピンク':     ['pink'],
  'ホワイト':   ['white'],
  'ブラック':   ['black'],
  'レッド':     ['red'],
  'ブルー':     ['blue'],
  'グリーン':   ['green'],
  'イエロー':   ['yellow'],
  'パープル':   ['purple'],
  'オレンジ':   ['orange'],
  'ベージュ':   ['beige'],
  'グレー':     ['grey', 'gray'],
  'ネイビー':   ['navy'],
  'ブラウン':   ['brown'],
  'シルバー':   ['silver'],
  'ゴールド':   ['gold'],
  'アイボリー': ['ivory'],
  'クリーム':   ['cream'],
  'コーラル':   ['coral'],
  'サーモン':   ['salmon'],
  'ラベンダー': ['lavender'],
  'ミント':     ['mint'],
  'ターコイズ': ['turquoise'],
  'チャコール': ['charcoal'],
  'マスタード': ['mustard'],
  'バーガンディ': ['burgundy'],
  'カーキ':     ['khaki'],
  'オリーブ':   ['olive'],
  'ライム':     ['lime'],
  'アクア':     ['aqua'],
  'インディゴ': ['indigo'],
  'スレート':   ['slate'],
  // 日常語 → カタカナ・EN（水色が最重要: ライトブルー/スカイブルーと完全同義）
  '水色':       ['ライトブルー', 'スカイブルー', 'light blue', 'sky blue', 'celeste', 'lightblue'],
  '茶色':       ['ブラウン', 'brown'],
  '桃色':       ['ピンク', 'pink'],
  'ライトブルー': ['水色', 'スカイブルー', 'light blue', 'sky blue', 'celeste', 'lightblue'],
  'スカイブルー': ['水色', 'ライトブルー', 'sky blue', 'light blue', 'celeste'],
  'ライトグリーン': ['light green', 'mint', 'ミント', 'sage', 'jade'],
  '白': ['white', 'ホワイト'],
  '黒': ['black', 'ブラック'],
  '赤': ['red',   'レッド'],
  '青': ['blue',  'ブルー'],
  '緑': ['green', 'グリーン'],
  '黄': ['yellow','イエロー'],
  '紫': ['purple','パープル'],
  // EN → JP
  'pink':     ['ピンク'],
  'white':    ['ホワイト', '白'],
  'black':    ['ブラック', '黒'],
  'red':      ['レッド', '赤'],
  'blue':     ['ブルー', '青'],
  'green':    ['グリーン', '緑'],
  'yellow':   ['イエロー', '黄'],
  'purple':   ['パープル', '紫'],
  'orange':   ['オレンジ'],
  'beige':    ['ベージュ'],
  'grey':     ['グレー'],
  'gray':     ['グレー'],
  'navy':     ['ネイビー'],
  'brown':    ['ブラウン'],
  'silver':   ['シルバー'],
  'gold':     ['ゴールド'],
  'ivory':    ['アイボリー'],
  'cream':    ['クリーム'],
  'coral':    ['コーラル'],
  'salmon':   ['サーモン'],
  'lavender': ['ラベンダー'],
  'mint':     ['ミント'],
  'turquoise':['ターコイズ'],
  'charcoal': ['チャコール'],
  'mustard':  ['マスタード'],
  'burgundy': ['バーガンディ'],
  'khaki':    ['カーキ'],
  'olive':    ['オリーブ'],
  'lime':     ['ライム'],
  'aqua':     ['アクア'],
  'indigo':   ['インディゴ'],
  'slate':    ['スレート'],
  // ブランド固有色 → 汎用色（Nike Celeste = 水色系、Midnight = 黒/ネイビー系 等）
  'celeste':  ['水色', 'ライトブルー', 'スカイブルー', 'sky blue', 'light blue'],
  'teal':     ['ターコイズ', 'アクア', 'グリーン', 'turquoise', 'aqua'],
  'jade':     ['グリーン', 'ミント', 'green', 'mint', 'ライトグリーン'],
  'sage':     ['グリーン', 'カーキ', 'green', 'khaki', 'ライトグリーン'],
  'mauve':    ['ピンク', 'パープル', 'ラベンダー', 'pink', 'purple', 'lavender'],
  'taupe':    ['ベージュ', 'グレー', 'beige', 'gray'],
  'ecru':     ['ベージュ', 'アイボリー', 'beige', 'ivory', 'エクルー'],
};

/**
 * キーワードから色ワードを抽出する。
 *
 * @param {string} keyword
 * @returns {string[]}  例: ["ピンク", "white"]（重複なし、元の表記で返す）
 */
export function extractColorKeywords(keyword) {
  if (!keyword) return [];
  const found = [];

  // 日本語色: 元のキーワードでそのまま検索（大小文字区別なし）
  for (const c of JP_COLORS) {
    if (keyword.includes(c)) found.push(c);
  }

  // 英語色: 小文字に変換して比較
  const kwLower = keyword.toLowerCase();
  for (const c of EN_COLORS) {
    if (kwLower.includes(c)) found.push(c);
  }

  return [...new Set(found)];
}

/**
 * アイテムタイトルがキーワードの色条件を満たすか判定する。
 *
 * @param {string} itemTitle
 * @param {string} keyword
 * @returns {boolean}
 *   true  = 色条件を満たす（通過）
 *   false = 色が欠けている（廃棄）
 */
/**
 * タイトル・ショップ色ラベル・タグを結合した検索用文字列
 * @param {{ title?: string, colorLabel?: string, tags?: string[] }} item
 */
export function buildColorMatchBlob(item) {
  const parts = [
    item.title,
    item.colorLabel,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ].filter(Boolean);
  return parts.join(' ').toLowerCase();
}

/**
 * 色指定ありのとき、タイトル／色ラベル／タグのいずれかに色（同義語）が含まれるか
 */
export function validateColorMatchForItem(item, keyword) {
  const colors = extractColorKeywords(keyword);
  if (colors.length === 0) return true;

  const blob = buildColorMatchBlob(item);

  for (const c of colors) {
    const synonyms = [c, ...(COLOR_CROSS_MAP[c] || [])];
    const found = synonyms.some(s => blob.includes(String(s).toLowerCase()));
    if (!found) {
      console.log(
        `[color-filter] 色不一致: "${c}" → blob先頭="${blob.slice(0, 80)}..."`
      );
      return false;
    }
  }
  return true;
}

/** @deprecated 互換: タイトルのみ */
export function validateColorMatch(itemTitle, keyword) {
  return validateColorMatchForItem({ title: itemTitle }, keyword);
}

/**
 * キーワードに含まれる色ワードを同義語に展開したキーワード文字列を返す。
 *
 * 波及検索で「水色」→「水色 ライトブルー celeste」のように拡張し、
 * 楽天・Yahoo で表記揺れをカバーする。
 *
 * @param {string} keyword
 * @param {number} maxSynonymsPerColor  1色あたりの追加同義語数（デフォルト2）
 * @returns {string}
 */
export function expandColorQuery(keyword, maxSynonymsPerColor = 2) {
  if (!keyword) return keyword || '';
  const colors = extractColorKeywords(keyword);
  if (colors.length === 0) return keyword;

  const additions = [];
  for (const c of colors) {
    const synonyms = (COLOR_CROSS_MAP[c] || []).slice(0, maxSynonymsPerColor);
    for (const s of synonyms) {
      // 既にキーワードに含まれていなければ追加
      if (!keyword.toLowerCase().includes(s.toLowerCase())) {
        additions.push(s);
      }
    }
  }

  return additions.length > 0 ? `${keyword} ${additions.join(' ')}` : keyword;
}

/**
 * アイテム配列から色不一致のものを一括除去する。
 *
 * @param {object[]} items   { title: string, ... }[]
 * @param {string}   keyword
 * @returns {object[]}
 */
export function filterByColor(items, keyword) {
  const colors = extractColorKeywords(keyword);
  if (colors.length === 0) return items;

  console.log(`[color-filter] 色フィルター適用（タイトル+色表示+タグ）: ${colors.join(', ')}`);
  const before = items.length;
  const result = items.filter(item => validateColorMatchForItem(item, keyword));
  if (result.length < before) {
    console.log(`[color-filter] ${before - result.length}件の色不一致を除外 (${before}→${result.length}件)`);
  }
  return result;
}
