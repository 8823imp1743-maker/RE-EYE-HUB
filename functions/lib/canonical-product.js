/**
 * canonical-product.js
 *
 * 商品名正規化 + シグナル抽出エンジン（Canonical Product Engine）。
 *
 * 目的:
 *   楽天/Yahoo/公式サイトなど店舗ごとにバラバラな商品名表記を、
 *   「ひとつの商品」として同一視できる canonical 表現に変換する。
 *
 *   例:
 *     "Nike Air Jordan 1 High OG \"Chicago\" 2015 27.0cm" → "nike aj1 chicago"
 *     "JORDAN BRAND AJ1 RETRO HIGH OG CHICAGO 555088-101"  → "nike aj1 chicago"
 *     "ちいかわ ぬいぐるみ ハチワレ Lサイズ BIG"            → "chiikawa hachiware"
 *
 * 設計原則:
 *   - AI不使用（ランニングコスト0円）
 *   - 辞書ルールベース（ルールをGrowさせる方式）
 *   - 開発者が失敗ログを見て辞書を追加して精度を上げる
 */

// ── ブランド正規化辞書 ─────────────────────────────────────────────
// 「ユーザーが入力しそうな表記」→「canonical brand ID」
const BRAND_MAP = new Map([
  // スニーカー
  ['nike', 'nike'], ['ナイキ', 'nike'], ['NIKE', 'nike'],
  ['jordan', 'nike'], ['jordan brand', 'nike'], ['air jordan', 'nike'],
  ['adidas', 'adidas'], ['アディダス', 'adidas'],
  ['new balance', 'newbalance'], ['ニューバランス', 'newbalance'], ['nb', 'newbalance'],
  ['vans', 'vans'], ['バンズ', 'vans'],
  ['converse', 'converse'], ['コンバース', 'converse'],
  ['asics', 'asics'], ['アシックス', 'asics'],
  ['puma', 'puma'], ['プーマ', 'puma'],
  ['reebok', 'reebok'], ['リーボック', 'reebok'],
  ['salomon', 'salomon'], ['サロモン', 'salomon'],
  ['on', 'on'], ['オン', 'on'],
  ['hoka', 'hoka'], ['ホカ', 'hoka'],
  // キャラクター
  ['ちいかわ', 'chiikawa'], ['chiikawa', 'chiikawa'],
  ['サンリオ', 'sanrio'], ['sanrio', 'sanrio'],
  ['ポケモン', 'pokemon'], ['pokemon', 'pokemon'], ['ポケカ', 'pokemon'],
  ['ハローキティ', 'hellokitty'], ['hello kitty', 'hellokitty'],
  ['マイメロ', 'mymelody'], ['my melody', 'mymelody'],
  ['シナモロール', 'cinnamoroll'], ['cinnamoroll', 'cinnamoroll'],
  ['ディズニー', 'disney'], ['disney', 'disney'],
  ['ジブリ', 'ghibli'], ['ghibli', 'ghibli'],
  ['ピクサー', 'pixar'], ['pixar', 'pixar'],
  // コスメ
  ['mac', 'mac'], ['m·a·c', 'mac'],
  ['nars', 'nars'], ['ナーズ', 'nars'],
  ['shiseido', 'shiseido'], ['資生堂', 'shiseido'],
  ['lancome', 'lancome'], ['ランコム', 'lancome'],
  ['dior', 'dior'], ['ディオール', 'dior'],
  ['chanel', 'chanel'], ['シャネル', 'chanel'],
  // フィギュア・グッズ
  ['バンダイ', 'bandai'], ['bandai', 'bandai'],
  ['バンダイナムコ', 'bandai'], ['bandai namco', 'bandai'],
  ['フィグマ', 'figma'], ['figma', 'figma'],
  ['ねんどろいど', 'nendoroid'], ['nendoroid', 'nendoroid'],
  ['コトブキヤ', 'kotobukiya'],
  // ホビー
  ['ガンプラ', 'gunpla'], ['ガンダム', 'gundam'], ['gundam', 'gundam'],
  ['ポケカ', 'pokeka'], ['ポケモンカード', 'pokeka'],
]);

// ── モデル正規化辞書（スニーカー特化） ──────────────────────────────
// 表記ゆれを統一する
const MODEL_MAP = new Map([
  // Air Jordan
  ['air jordan 1', 'aj1'], ['jordan 1', 'aj1'], ['aj1', 'aj1'], ['aj 1', 'aj1'],
  ['air jordan 1 high', 'aj1'], ['aj1 high', 'aj1'],
  ['air jordan 1 mid', 'aj1mid'], ['aj1 mid', 'aj1mid'],
  ['air jordan 1 low', 'aj1low'], ['aj1 low', 'aj1low'],
  ['air jordan 3', 'aj3'], ['jordan 3', 'aj3'], ['aj3', 'aj3'],
  ['air jordan 4', 'aj4'], ['jordan 4', 'aj4'], ['aj4', 'aj4'],
  ['air jordan 5', 'aj5'], ['jordan 5', 'aj5'],
  ['air jordan 11', 'aj11'], ['jordan 11', 'aj11'],
  // Air Force
  ['air force 1', 'af1'], ['air force one', 'af1'], ['af1', 'af1'],
  ['air force 1 low', 'af1low'], ['air force 1 high', 'af1high'],
  // Air Max
  ['air max 1', 'am1'], ['airmax 1', 'am1'],
  ['air max 90', 'am90'], ['airmax 90', 'am90'],
  ['air max 95', 'am95'], ['air max 97', 'am97'],
  // Dunk
  ['dunk low', 'dunklw'], ['dunk high', 'dunkhigh'], ['dunk', 'dunk'],
  ['sb dunk', 'sbdunk'], ['dunk sb', 'sbdunk'],
  // Yeezy
  ['yeezy 350', 'yeezy350'], ['yeezy boost 350', 'yeezy350'],
  ['yeezy 700', 'yeezy700'], ['yeezy 500', 'yeezy500'],
  // New Balance
  ['990v4', 'nb990v4'], ['990v5', 'nb990v5'], ['990v6', 'nb990v6'],
  ['992', 'nb992'], ['993', 'nb993'], ['998', 'nb998'],
  ['2002r', 'nb2002r'], ['1906r', 'nb1906r'],
  // ちいかわキャラ
  ['ちいかわ', 'chiikawa'], ['ハチワレ', 'hachiware'], ['うさぎ', 'usagi'],
  ['もんじゃ', 'monja'], ['くりまんじゅう', 'kurimanju'],
]);

// ── カラー正規化辞書 ─────────────────────────────────────────────
const COLOR_MAP = new Map([
  ['chicago', 'chicago'], ['シカゴ', 'chicago'],
  ['bred', 'bred'], ['ブレッド', 'bred'],
  ['royal', 'royal'], ['ロイヤル', 'royal'],
  ['shadow', 'shadow'], ['シャドウ', 'shadow'],
  ['mocha', 'mocha'], ['モカ', 'mocha'],
  ['university blue', 'univblue'], ['ユニバーシティブルー', 'univblue'],
  ['off white', 'offwhite'], ['off-white', 'offwhite'],
  ['travis scott', 'travis'], ['トラビス', 'travis'],
  ['fragment', 'fragment'], ['フラグメント', 'fragment'],
  ['obsidian', 'obsidian'],
  ['court purple', 'courtpurple'],
  ['celeste', 'celeste'], ['水色', 'celeste'], ['ライトブルー', 'celeste'],
]);

// ── ノイズワード（除去対象） ──────────────────────────────────────
const NOISE_WORDS = new Set([
  '新品', '未使用', '正規品', '本物', '送料無料', '即発送', '即納',
  '国内正規', '国内正規品', '日本未発売', 'レア', 'レア品',
  '限定', '激レア', '入手困難', 'デッドストック', 'DS', 'DS品',
  '27.0cm', '26.5cm', '28.0cm',  // サイズはここでは削除
  'cm', 'us', 'uk', 'eu',
  '箱あり', 'ボックスあり', 'タグあり', 'コンディション',
  'new', 'used', '中古',
  'sale', 'セール', 'アウトレット',
]);

/**
 * テキストから canonical product name を生成する。
 * 複数店舗の同一商品を同一視するためのキー生成に使う。
 *
 * @param {string} text
 * @returns {string} canonical name（スペース区切り小文字）
 */
export function normalizeProductName(text) {
  if (!text) return '';

  let s = text.toLowerCase();

  // モデル正規化（長い表記を先にマッチさせる）
  const modelKeys = [...MODEL_MAP.keys()].sort((a, b) => b.length - a.length);
  for (const k of modelKeys) {
    if (s.includes(k.toLowerCase())) {
      s = s.replace(k.toLowerCase(), MODEL_MAP.get(k));
    }
  }

  // カラー正規化
  for (const [k, v] of COLOR_MAP) {
    if (s.includes(k.toLowerCase())) {
      s = s.replace(k.toLowerCase(), v);
    }
  }

  // ブランド正規化
  for (const [k, v] of BRAND_MAP) {
    if (s.includes(k.toLowerCase())) {
      s = s.replace(k.toLowerCase(), v);
    }
  }

  // ノイズ除去: サイズ cm 表記、SKU番号、特殊文字
  s = s
    .replace(/\d{2,3}(\.\d)?cm/gi, '')           // 27.0cm, 28cm
    .replace(/us\s?\d{1,2}(\.\d)?/gi, '')          // US 10.5
    .replace(/\b\d{6}-\d{3}\b/g, '')               // 555088-101 (SKU)
    .replace(/["""「」【】（）()［］\[\]{}]/g, ' ')
    .replace(/[^\w\s\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // ノイズワード除去
  const tokens = s.split(' ').filter(t => t.length > 0 && !NOISE_WORDS.has(t));

  return tokens.join(' ').trim().slice(0, 80);
}

/**
 * テキストから商品シグナルを抽出する。
 * モニター登録時の構造化データとして使う。
 *
 * @param {string} text - タイトルや説明文
 * @returns {{ brand: string, model: string, color: string, category: string }}
 */
export function extractProductSignals(text) {
  const lower = (text || '').toLowerCase();

  let brand = '';
  for (const [k, v] of BRAND_MAP) {
    if (lower.includes(k.toLowerCase())) { brand = v; break; }
  }

  let model = '';
  const modelKeys = [...MODEL_MAP.keys()].sort((a, b) => b.length - a.length);
  for (const k of modelKeys) {
    if (lower.includes(k.toLowerCase())) { model = MODEL_MAP.get(k); break; }
  }

  let color = '';
  for (const [k, v] of COLOR_MAP) {
    if (lower.includes(k.toLowerCase())) { color = v; break; }
  }

  const category = detectCategory(lower);

  return { brand, model, color, category };
}

/**
 * キーワードからカテゴリを推定する。
 * monitor.js の mode 判定に使う。
 *
 * @param {string} keyword
 * @returns {'sneaker' | 'cosmetics' | 'figure' | 'card' | 'fashion' | 'character' | 'standard'}
 */
export function detectCategory(keyword) {
  const s = (keyword || '').toLowerCase();

  if (/sneaker|スニーカー|シューズ|ナイキ|adidas|jordan|dunk|yeezy|靴|shoes/.test(s)) return 'sneaker';
  if (/コスメ|コスメティクス|リップ|ファンデ|アイシャドウ|限定色|限定コスメ|cosmetic|makeup|lipstick/.test(s)) return 'cosmetics';
  if (/フィギュア|ねんどろいど|figma|figure|nendoroid|コトブキヤ/.test(s)) return 'figure';
  if (/カード|ポケカ|ポケモンカード|trading card|mtg|遊戯王|card/.test(s)) return 'card';
  if (/ちいかわ|サンリオ|ディズニー|ジブリ|ポケモン|キャラ|ぬいぐるみ|グッズ/.test(s)) return 'character';
  if (/ガンプラ|ガンダム|プラモ|gundam|gunpla/.test(s)) return 'figure';
  if (/ファッション|アパレル|パーカー|ジャケット|fashion|apparel/.test(s)) return 'fashion';

  return 'standard';
}

/**
 * keyword と urls から Product エントリを構築する。
 * 将来の Canonical Product DB のスキーマ準拠形式。
 *
 * @param {object} opts
 * @param {string} opts.keyword - ユーザー登録キーワード
 * @param {string[]} opts.urls  - 発見された URL リスト
 * @param {string} [opts.userId]
 * @returns {object}
 */
export function buildProductEntry({ keyword, urls = [], userId = '' }) {
  const canonical = normalizeProductName(keyword);
  const signals   = extractProductSignals(keyword);
  const category  = signals.category || detectCategory(keyword);

  return {
    canonicalName: canonical,
    originalKeyword: keyword,
    userId,
    category,
    mode: category === 'sneaker' ? 'sneaker' : 'standard',
    signals,
    urls: [...new Set(urls)],
    createdAt: Date.now(),
  };
}
