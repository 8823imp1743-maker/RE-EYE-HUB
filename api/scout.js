/**
 * POST /api/scout
 * インテル・スカウター — オンデマンド巡回 API
 *
 * リクエスト Body（省略可）:
 *   { keywords?: string[] }   省略時はデフォルトシードを使用
 *
 * レスポンス:
 *   { ok, newCount, items, errors, scannedAt }
 *
 * スケジューラー（index.js の scoutScheduler）からも同じロジックを使う。
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { scanAll }             from '../lib/rss-scanner.js';
import { jitterDelay }         from '../lib/stealth.js';

/**
 * デフォルトシードキーワード
 * ユーザーが「見守り開始」で送ったキーワードが渡されれば優先される。
 */
const DEFAULT_SEEDS = [
  'スニーカー 新作 限定',
  '再販 再入荷 予約開始',
  'ルイヴィトン グッチ 新作',
  'ポケモン グッズ 入荷',
  'コラボ 限定 発売',
];

/** 1 回の巡回で処理するキーワードの上限（展開前の基本数） */
const MAX_KEYWORDS = 5;

/** 展開後の上限 */
const MAX_EXPANDED = 12;

// ── 日本語ブランド名 → 英語名テーブル（英名クエリを自動付加） ──────────
const JP_TO_EN = {
  'ヴィトン':   'Vuitton',
  'グッチ':     'Gucci',
  'シャネル':   'Chanel',
  'プラダ':     'Prada',
  'エルメス':   'Hermes',
  'バレンシアガ':'Balenciaga',
  'ポケモン':   'Pokemon',
  'ガンダム':   'Gundam',
  'ワンピース': 'One Piece',
  'ナルト':     'Naruto',
  'キティ':     'Hello Kitty',
  'ディズニー': 'Disney',
  'マリオ':     'Mario',
  'ゼルダ':     'Zelda',
  'ナイキ':     'Nike',
  'アディダス': 'Adidas',
  'ニューバランス': 'New Balance',
};

// ── カテゴリ別「聖地」店名テーブル ────────────────────────────────────
// ※ Google News RSS は site: 演算子を受け付けないため店名テキストで代替
const CATEGORY_DOMAINS = {
  'おもちゃ':    ['バンダイ', 'タカラトミー', 'アミアミ'],
  'フィギュア':  ['アミアミ', 'グッドスマイルカンパニー', 'コトブキヤ'],
  'グッズ':      ['一番くじ', 'バンダイ', 'コミケ'],
  'シール':      ['バンダイ', 'よりどり', 'ガチャ'],
  'ポケモン':    ['ポケモンセンター', 'バンダイ', 'コロコロ'],
  'BTS':         ['ウィバース', 'ユニバーサルミュージック', 'タワーレコード'],
  'アイドル':    ['ユニバーサルミュージック', 'ソニーミュージック', 'タワーレコード'],
  'スニーカー':  ['ナイキ', 'アディダス', 'アトモス'],
  'ヴィトン':    ['ルイヴィトン', '正規品', '直営店'],
  'グッチ':      ['グッチ', '正規品', '直営店'],
  'カード':      ['トレカ', '遊戯王', 'ポケカ'],
  'ゲーム':      ['任天堂', 'プレイステーション', 'ニンテンドーストア'],
};

// ── 未知キーワードへの汎用 EC フォールバック ────────────────────────────
const GENERIC_EC_FALLBACK = ['amazon', 'rakuten', '公式通販'];

/**
 * Gemini API で未知キーワードに最適なクエリを推論する（AI 推論拡張）。
 * 3 秒以内に返らない場合は空配列を返してサイレント fallback する。
 *
 * @param {string} keyword
 * @returns {Promise<string[]>}  最大 3 件の追加クエリ
 */
async function geminiExpandKeyword(keyword) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: { maxOutputTokens: 80, temperature: 0.1 },
    });
    const prompt =
      `商品キーワード「${keyword}」に関するGoogleニュース検索に最適な日本語クエリを3つ提案してください。` +
      `公式発表・予約・入荷情報が拾えるクエリを優先してください。` +
      `回答はJSON配列のみ。例: ["${keyword} 予約開始", "${keyword} 公式発売", "${keyword} 再販情報"]`;

    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    const text = result.response.text();
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed)
      ? parsed.filter(k => typeof k === 'string' && k.trim()).slice(0, 3)
      : [];
  } catch (e) {
    console.warn('[scout] Gemini 推論スキップ:', e.message);
    return [];
  }
}

/**
 * ブランド名単体（スペースなし）を複数の複合クエリへ展開する。
 * 英語名付加 → 行動語クエリ → 聖地店名 → AI 推論の順で拡張。
 * Google News RSS で確実に機能する純テキストクエリのみ使用。
 *
 * @param {string[]} seeds
 * @returns {Promise<string[]>}
 */
async function expandKeywords(seeds) {
  // 公式ページ・告知ページで多用される語句を網羅
  const INTEL_SUFFIXES = [
    '新作 限定',
    '予約 発表',
    '在庫 再販',
    '告知 案内',
    'ONLINE 販売決定',
    '特設ページ 公式',
  ];

  const expanded = [];
  for (const seed of seeds) {
    if (expanded.length >= MAX_EXPANDED) break;
    expanded.push(seed);

    // 単語のみキーワード（スペースなし）を展開
    if (!seed.includes(' ')) {
      // 1. 英語名クエリ（JP_TO_EN に登録済みの場合）
      const enName = JP_TO_EN[seed];
      if (enName && expanded.length < MAX_EXPANDED) {
        expanded.push(enName + ' 新作 限定');
      }

      // 2. 汎用行動語クエリ
      for (const suf of INTEL_SUFFIXES) {
        if (expanded.length >= MAX_EXPANDED) break;
        expanded.push(seed + ' ' + suf);
      }

      // 3. 聖地店名クエリ（登録済み）または汎用 EC フォールバック
      const holy = CATEGORY_DOMAINS[seed] || GENERIC_EC_FALLBACK;
      for (const shop of holy) {
        if (expanded.length >= MAX_EXPANDED) break;
        expanded.push(seed + ' ' + shop);
      }

      // 4. AI 推論拡張（未知キーワードかつ枠に余裕がある場合のみ、環境変数で明示的に有効化）
      if (!CATEGORY_DOMAINS[seed] && expanded.length < MAX_EXPANDED &&
          process.env.GEMINI_SCOUT_ENABLED === 'true') {
        const aiSuggestions = await geminiExpandKeyword(seed);
        for (const kw of aiSuggestions) {
          if (expanded.length >= MAX_EXPANDED) break;
          if (!expanded.includes(kw)) expanded.push(kw);
        }
      }
    }
  }
  return expanded;
}

/**
 * HTTP ハンドラ（POST /api/scout）
 */
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const body   = req.method === 'POST' ? (req.body || {}) : {};
  const seeds  = await expandKeywords(resolveSeeds(body.keywords));

  // ── デバッグログ：展開クエリを全開示 ──
  console.log(`[scout] 展開クエリ (${seeds.length}本): ${seeds.map(s => `"${s}"`).join(' | ')}`);

  const { items, errors, totalFoundInFeed } = await scanAll(seeds);

  // ── デバッグログ：スキャン結果サマリー ──
  console.log(`[scout] totalFoundInFeed=${totalFoundInFeed} / newCount=${items.length} / errors=${errors.length}`);
  if (errors.length > 0) errors.forEach(e => console.warn('[scout] error:', e));

  return res.status(200).json({
    ok:              true,
    newCount:        items.length,
    items,
    errors,
    totalFoundInFeed,
    scannedAt:       Date.now(),
  });
}

/**
 * スケジューラーから直接呼ぶエントリーポイント。
 * 起動直後にジッター遅延を挿入してボット検知を分散させる。
 *
 * @param {string[]} [customSeeds]  ユーザー設定から渡すキーワード群
 */
export async function runScheduledScout(customSeeds) {
  // Cloud Functions の cron は同時刻に一斉起動するため最大 3 分ジッター
  await jitterDelay(3 * 60 * 1000);

  const seeds = await expandKeywords(resolveSeeds(customSeeds));
  console.log(`[scout] 巡回開始: ${seeds.join(' / ')}`);

  const { items, errors, totalFoundInFeed } = await scanAll(seeds);
  console.log(`[scout] フィード総件数: ${totalFoundInFeed}`);

  if (errors.length > 0) {
    errors.forEach(e => console.error('[scout]', e));
  }

  console.log(`[scout] 完了: 新着 ${items.length} 件`);
  return { items, errors };
}

/** キーワードリストを正規化（最大 MAX_KEYWORDS 件・デフォルトフォールバック） */
function resolveSeeds(raw) {
  if (!raw) return DEFAULT_SEEDS.slice(0, MAX_KEYWORDS);
  const arr = Array.isArray(raw) ? raw : [raw];
  const valid = arr.filter(k => typeof k === 'string' && k.trim());
  return valid.length > 0
    ? valid.slice(0, MAX_KEYWORDS)
    : DEFAULT_SEEDS.slice(0, MAX_KEYWORDS);
}
