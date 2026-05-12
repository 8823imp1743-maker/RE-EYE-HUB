/**
 * RE-EYE-HUB 基盤：精密ノイズガード V6.4 FINAL
 */

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
    '中敷き'
  ];
  
  export const SOFT_PENALTY_RULES = [
    { word: '中古', penalty: 30 },
    { word: 'used', penalty: 30 },
    { word: '古着', penalty: 30 },
  
    { word: '訳あり', penalty: 40 },
    { word: '並行輸入', penalty: 15 },
    { word: 'アウトレット', penalty: 20 },
  
    { word: 'wmns', penalty: 50 },
    { word: 'women', penalty: 50 },
    { word: 'ウィメンズ', penalty: 50 },
    { word: 'レディース', penalty: 50 },
  
    { word: 'gs', penalty: 40 },
    { word: 'kids', penalty: 50 },
    { word: 'infant', penalty: 60 }
  ];
  
  export const SAFE_BOOST_RULES = [
    { word: '新品', boost: 20 },
    { word: '未使用', boost: 20 },
  
    { word: '国内正規品', boost: 30 },
    { word: '正規品', boost: 15 }
  ];
  
  export const HARD_REJECT_DOMAINS = [
    'mercari.com',
    'auctions.yahoo.co.jp',
    'fril.jp',
    'rakuma.jp',
    'paypayfleamarket.yahoo.co.jp'
  ];
  
  export function analyzeNoise(item = {}) {
  
    const title =
      String(item.title || '')
        .toLowerCase()
        .trim();
  
    const desc =
      String(item.description || '')
        .toLowerCase()
        .trim();
  
    const url =
      String(item.url || item.sourceUrl || '')
        .toLowerCase()
        .trim();
  
    const haystack = `
  ${title}
  ${desc}
  `;
  
    for (const domain of HARD_REJECT_DOMAINS) {
  
      if (url.includes(domain)) {
  
        return {
          isNoise: true,
          scoreDelta: -999,
          reasons: [`DOMAIN:${domain}`]
        };
      }
    }
  
    for (const word of HARD_REJECT_WORDS) {
  
      const normalizedWord =
        String(word)
          .toLowerCase()
          .trim();
  
      if (haystack.includes(normalizedWord)) {
  
        return {
          isNoise: true,
          scoreDelta: -999,
          reasons: [`WORD:${word}`]
        };
      }
    }
  
    let scoreDelta = 0;
  
    const reasons = [];
  
    for (const rule of SOFT_PENALTY_RULES) {
  
      const word =
        String(rule.word || '')
          .toLowerCase();
  
      if (haystack.includes(word)) {
  
        scoreDelta -= Number(rule.penalty || 0);
  
        reasons.push(`SOFT:${rule.word}`);
      }
    }
  
    for (const rule of SAFE_BOOST_RULES) {
  
      const word =
        String(rule.word || '')
          .toLowerCase();
  
      if (haystack.includes(word)) {
  
        scoreDelta += Number(rule.boost || 0);
  
        reasons.push(`BOOST:${rule.word}`);
      }
    }
  
    return {
      isNoise: false,
      scoreDelta,
      reasons
    };
  }
  
  export const filterNoise = analyzeNoise;
  export const noiseGuard = analyzeNoise;
  export const analyzeItemNoise = analyzeNoise;
  
  export default analyzeNoise;