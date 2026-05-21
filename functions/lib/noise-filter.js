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

export const SOFT_PENALTY_RULES = [
  { word: '中古', penalty: 30 },
  { word: 'used', penalty: 30 },
  { word: '古着', penalty: 30 },

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

// ─────────────────────────────────────
// MAIN
// ─────────────────────────────────────

export function analyzeNoise(item = {}) {
  const title = String(item.title || '').toLowerCase();
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