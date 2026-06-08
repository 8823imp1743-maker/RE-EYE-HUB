/**
 * RE-EYE-HUB 精密ノイズガード V4
 * 「AIの前に、論理で殺す」
 */

// ─────────────────────────────────────
// HARD REJECT（100%ゴミ）
// ─────────────────────────────────────

export const HARD_REJECT_WORDS = [
  '空箱',
  '箱のみ',
  'boxのみ',
  'パッケージのみ',
  'ケースのみ',
  '空瓶',
  '空ボトル',

  '部品取り',
  '修理用',
  '故障',
  'ジャンク',
  'junk',

  'コピー品',
  'フェイク',
  'レプリカ',

  'シューレース',
  '靴紐',
  '靴ひも',
  '替え紐',
  '替紐',
  'shoelace',

  'インソール',
  '中敷き',
];

// ─────────────────────────────────────
// SOFT PENALTY（減点）
// ─────────────────────────────────────

/** タイトルに含まれたら即除外（新品在庫監視向け・AI不要） */
const USED_TITLE_PATTERNS = [
  /【中古】/,
  /\(中古\)/,
  /（中古）/,
  /\b中古品\b/,
  /\b古着\b/,
  /\bvintage\b/i,
  /\bused\b/i,
  /\bpre-?owned\b/i,
];

export const SOFT_PENALTY_RULES = [
  { word: '訳あり', penalty: 40 },

  { word: 'コンディション', penalty: 20 },

  { word: '並行輸入', penalty: 15 },

  { word: 'アウトレット', penalty: 20 },
];

// ─────────────────────────────────────
// SAFE BOOST（加点）
// ─────────────────────────────────────

export const SAFE_BOOST_RULES = [
  { word: '新品', boost: 20 },
  { word: '国内正規品', boost: 30 },
  { word: '正規品', boost: 15 },
];

// ─────────────────────────────────────
// DOMAIN
// ─────────────────────────────────────

export const HARD_REJECT_DOMAINS = [
  'mercari.com',
  'auctions.yahoo.co.jp',
  'fril.jp',
  'rakuma.jp',
];

/** Yahoo ジャンル: メンズシューズ / レディースシューズ */
const YAHOO_SHOE_GENRE_IDS = new Set(['2495', '2496']);

/** 靴検索時にアパレル誤ヒット（Tシャツにエアマックス等）を弾く */
const APPAREL_POLLUTION_RE =
  /トップス|Ｔシャツ|Tシャツ|t-?shirt|半袖|ラッシュガード|ジャージ|パーカー|ボトムス|ショーツ|キャップ|帽子|ソックス|靴下|アパレル|インナー|下着|カジュアルウエア|カジュアルウェア|スポーツウェア|スポーツウエア/i;

const EXPLICIT_SHOE_TITLE_RE =
  /スニーカー|シューズ|sneaker|ランニングシューズ|バスケットシューズ|スニーカ/i;

// ─────────────────────────────────────
// MAIN
// ─────────────────────────────────────

export function titleIsUsedMarket(title) {
  const t = String(title || '');
  if (!t.trim()) return false;
  if (USED_TITLE_PATTERNS.some((re) => re.test(t))) return true;
  return t.includes('中古') || t.includes('古着');
}

/**
 * 靴意図のモール検索で、アパレル（Tシャツ等）がキーワード汚染で混入したか。
 * 「エア マックス 90」コラボTシャツは explicit な スニーカー/シューズ が無ければ除外。
 */
export function isShoeApparelPollution(item = {}) {
  const title = String(item.title || item.name || '');
  if (!title.trim()) return false;
  if (EXPLICIT_SHOE_TITLE_RE.test(title)) return false;

  if (APPAREL_POLLUTION_RE.test(title)) return true;

  const genreId = String(item.genreCategoryId || item.yahooGenreId || '').trim();
  if (genreId && item.sourceId === 'yahoo' && !YAHOO_SHOE_GENRE_IDS.has(genreId)) {
    return true;
  }

  const genreName = String(item.genreCategoryName || '').trim();
  if (genreName) {
    if (/シューズ|スニーカー|靴/.test(genreName)) return false;
    if (/アパレル|トップス|Tシャツ|ラッシュガード|ウェア|ウエア|ファッション/.test(genreName)) {
      return true;
    }
  }

  return false;
}

export function filterShoeMallPollution(items) {
  return (items || []).filter((item) => !isShoeApparelPollution(item));
}

export function analyzeNoise(item = {}) {
  const rawTitle = String(item.title || item.name || '');
  const title = rawTitle.toLowerCase();
  const desc = String(item.description || '').toLowerCase();
  const url = String(item.url || item.sourceUrl || '').toLowerCase();

  const haystack = `${title}\n${desc}`;

  // ── HARD DOMAIN ───────────────────

  for (const domain of HARD_REJECT_DOMAINS) {
    if (url.includes(domain)) {
      return {
        isNoise: true,
        scoreDelta: -999,
        reasons: [`DOMAIN:${domain}`],
      };
    }
  }

  // ── 中古（タイトルのみ即死）────────────────
  if (titleIsUsedMarket(rawTitle)) {
    return {
      isNoise: true,
      scoreDelta: -999,
      reasons: ['WORD:中古'],
    };
  }

  // ── HARD WORD ─────────────────────

  for (const word of HARD_REJECT_WORDS) {
    if (title.includes(word.toLowerCase())) {
      return {
        isNoise: true,
        scoreDelta: -999,
        reasons: [`WORD:${word}`],
      };
    }
  }

  // ── SOFT ──────────────────────────

  let scoreDelta = 0;
  const reasons = [];

  for (const rule of SOFT_PENALTY_RULES) {
    if (haystack.includes(rule.word.toLowerCase())) {
      scoreDelta -= rule.penalty;
      reasons.push(`SOFT:${rule.word}`);
    }
  }

  // ── BOOST ─────────────────────────

  for (const rule of SAFE_BOOST_RULES) {
    if (haystack.includes(rule.word.toLowerCase())) {
      scoreDelta += rule.boost;
      reasons.push(`BOOST:${rule.word}`);
    }
  }

  return {
    isNoise: false,
    scoreDelta,
    reasons,
  };
}

/** 楽天 API の NGKeyword パラメータ（除外語）。必要に応じて拡張する。 */
export const RAKUTEN_NG_KEYWORD = '';

/**
 * Google News RSS 等のクエリに付加するノイズマイナスキーワード文字列。
 * scout.js / rss-scanner.js がベースとして使用する。
 */
export const QUERY_NOISE_MINUS =
  '-中古 -コピー品 -フェイク -レプリカ -ジャンク -空箱 -修理 -部品取り' +
  ' -シューレース -インソール -中敷 -靴ひも';

/**
 * アイテム配列からノイズを除去して返す。
 * @param {Array<{title?: string, description?: string, url?: string}>} items
 * @returns {typeof items}
 */
export function filterNoise(items) {
  return (items || []).filter((item) => !analyzeNoise(item).isNoise);
}