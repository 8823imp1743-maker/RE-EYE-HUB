/**
 * RE-EYE-HUB 冷徹フィルター
 *
 * 「新品・未発売のワクワク」だけを通す。中古・オークション・ゴミは一切通さない。
 *
 * 使用箇所:
 *   lib/shop-adapters/index.js  — searchAll() の結果を事後検閲
 *   api/monitor.js              — checkAndNotify() の結果を検閲
 *   api/scout.js                — Google News 結果を事後検閲
 */

// ── 禁止ワード（タイトル・説明文の事後検閲）────────────────────────────────
// このリストに1語でもマッチしたアイテムは即座に破棄する
export const BANNED_TITLE_WORDS = [
  // 中古・リユース系
  '中古', 'USED', 'Used', 'used', '古着', '古本', '古物',
  'ジャンク', 'junk', '訳あり', '難あり', 'ランクB', 'ランクC',
  'コンディション', '美品', 'やや傷', '使用感', '使用済',
  'リユース', 'リサイクル', 'セカンドハンド', '中古品',
  'B品', 'B級品', '返品', '訳有',
  '【未使用】', '未使用品', '未使用・未開封',

  // 海外サイズ表記（US/UKサイズは正規日本流通品ではない可能性大）
  ' US6', ' US7', ' US8', ' US9', ' US10', ' US11', ' US12', ' US13',
  'US 6', 'US 7', 'US 8', 'US 9', 'US 10', 'US 11', 'US 12', 'US 13',

  // オークション・転売系
  'オークション', '1円スタート', '即決価格', '落札', '入札',
  'メルカリ', 'ラクマ', 'ヤフオク', 'フリマ', 'フリル',
  '転売', '転売品', 'プレ値', 'プレミア価格',

  // 小物（靴本体の在庫検索では誤爆の中心 — 26.5cm 表記の替え紐等）
  'シューレース', 'ショーレース', '靴紐', '靴ひも', '替え紐', '替紐', 'shoelace',

  // 書籍・ムック（商品ではなく雑誌・本）
  'Special Book', 'special book',
  '本/雑誌', '本・雑誌', '書籍', 'ムック', 'スニーカー本', '図鑑',

  // その他ノイズ
  '廃番', '廃盤', 'デッドストック', 'サンプル品', '見本品',
];

// ── 禁止ドメイン（URL・sourceUrl 事後検閲）──────────────────────────────────
// このドメインが URL に含まれるアイテムは即座に破棄する
export const BANNED_DOMAINS = [
  'auctions.yahoo.co.jp',   // ヤフオク
  'mercari.com',             // メルカリ
  'fril.jp',                 // フリル
  'rakuma.jp',               // ラクマ
  'mbok.jp',                 // モバオク
  'buyee.jp',                // Buyee（代行）
  'snkrdunk.com',            // スニーカーダンク（中古多数）
  'snkrdunk.jp',
  'xl2.digivalley.co.jp',   // ヤフオク旧ドメイン
  'item.fril.jp',
  // 個人ブログ・無料ホスト（公式トレンドから除外）
  'ameblo.jp',
  'blog.fc2.com',
  'fc2.com',
  'fc2blog.net',
  'hatenablog.com',
  'hatenadiary.jp',
  'blog.livedoor.jp',
  'seesaa.net',
  'g.hatena.ne.jp',
];

// ── 事前排除クエリサフィックス（検索APIに投げる前に付加）───────────────────
// Google News RSS / 楽天 NGKeyword / Yahoo の query に追加して入口で弾く
export const QUERY_NOISE_MINUS =
  '-中古 -USED -used -古着 -ジャンク -オークション -フリマ -メルカリ -ヤフオク';

// ── 楽天 NGKeyword（NGKeyword パラメータ用：スペース区切り）────────────────
export const RAKUTEN_NG_KEYWORD =
  '中古 リユース USED used 訳あり ジャンク 難あり 古着 古物 ランクB コンディション ' +
  'オークション フリマ メルカリ ヤフオク 転売 B品';

/** タイトル・説明の両方で弾く（日記系は本文に出やすい） */
const AMATEUR_HAYSTACK_WORDS = ['愛犬', 'おばあちゃん', 'うちの犬', 'コラム', '日記', 'ブログ', '感想'];

/**
 * 単一アイテムがノイズかどうか判定する。
 *
 * @param {{ title?: string, url?: string, sourceUrl?: string, description?: string }} item
 * @returns {boolean}  true = ノイズ（破棄せよ） / false = クリーン（通過）
 */
export function isNoise(item) {
  const title = (item.title || '').toLowerCase();
  const desc  = (item.description || '').toLowerCase();
  const url   = (item.url || item.sourceUrl || '').toLowerCase();
  const hay   = title + '\n' + desc;

  // タイトルに禁止ワードが含まれるか
  for (const word of BANNED_TITLE_WORDS) {
    if (title.includes(word.toLowerCase())) {
      console.log(`[noise-filter] BANNED word="${word}" title="${item.title?.slice(0,50)}"`);
      return true;
    }
  }

  for (const w of AMATEUR_HAYSTACK_WORDS) {
    if (hay.includes(w.toLowerCase())) {
      console.log(`[noise-filter] AMATEUR marker="${w}" title="${item.title?.slice(0,50)}"`);
      return true;
    }
  }

  // URLに禁止ドメインが含まれるか
  for (const domain of BANNED_DOMAINS) {
    if (url.includes(domain)) {
      console.log(`[noise-filter] BANNED domain="${domain}" url="${url.slice(0,80)}"`);
      return true;
    }
  }

  return false;
}

/**
 * アイテム配列からノイズを一括除去する。
 *
 * @param {object[]} items
 * @returns {object[]}  クリーンなアイテムのみ
 */
export function filterNoise(items) {
  if (!Array.isArray(items)) return [];
  const before = items.length;
  const clean  = items.filter(item => !isNoise(item));
  if (before !== clean.length) {
    console.log(`[noise-filter] ${before - clean.length}件のノイズを排除 (${before}→${clean.length}件)`);
  }
  return clean;
}
