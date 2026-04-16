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
import { getGeminiModel } from '../lib/plan-config.js';
import { scanAll }             from '../lib/rss-scanner.js';
import { jitterDelay }         from '../lib/stealth.js';
import { resolveGoogleNewsToSource } from '../lib/google-news.js';
import { filterNoise, QUERY_NOISE_MINUS } from '../lib/noise-filter.js';

/**
 * URL先行判定 — ショップ/公式/品番入りURLを即時お宝フラグ
 * タイトルにキーワードがなくても公式ページは確定お宝。
 */
function isShopOrOfficialUrl(url) {
  if (!url) return false;
  try {
    const { hostname, pathname } = new URL(url);
    if (/\b(shop|official|store|boutique|ec)\b/i.test(hostname)) return true;
    if (/[A-Z]{2,}-\d{3,}/i.test(pathname)) return true;
    return false;
  } catch { return false; }
}

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

// ── ノイズ除去：中古市場・無関係ワードを全クエリに強制付加 ─────────────
// noise-filter.js の QUERY_NOISE_MINUS を基底とし、スカウト特有のワードを追加
const NOISE_MINUS =
  QUERY_NOISE_MINUS + ' -SNKRDUNK -スニダン -買取 -事件 -株価';

// ── 4カテゴリ別ブーストサフィックス（単語を空白 AND で結合） ────────────
// newitem/stock は商品名をそのまま追うためブーストなし
// campaign/oshi はカテゴリ特化語を付加して精度を上げる
const TREND_BOOST_TERMS = ['新作', '予約', '発売', '登場', 'キャンペーン']; // 後方互換

const MODE_BOOST = {
  newitem:  '',                        // 商品名そのまま — 余計なブーストなし
  stock:    '在庫 再販 入荷',          // 在庫復活特化
  campaign: 'キャンペーン 応募 抽選',  // 抽選・応募特化
  oshi:     'チケット 出演 特典',      // 推し活特化
};

// ── 温度スコア：記事の「新しさ × 勢い」を数値化 ─────────────────────────
const TEMP_SIGNAL_WORDS = ['新作', '予約', '発売', '限定', 'キャンペーン', '入荷', '再販', '登場', '公式', '解禁', '発表', 'チケット', '販売', '抽選', 'ライブ', 'コンサート', 'ツアー'];
const TEMP_NOISE_WORDS  = ['中古', 'SNKRDUNK', 'スニダン', '買取', 'メルカリ', 'ヤフオク', '古着', '事件', '株価'];

// ── 既知「他アーティスト・芸能人」ブラックリスト（プライマリに優先して出現したらドロップ）──
// ARTIST_MEMBERS のキーと代表メンバー名を平坦化しておき、
// 「他の芸能人がタイトルの主語にいる記事」を高速判定する。
const ALL_KNOWN_ARTISTS_LOWER = [
  'bts', 'akb48', 'ske48', 'nmb48', '乃木坂46', '日向坂46', '櫻坂46',
  'seventeen', 'enhypen', 'newjeans', 'aespa', 'snowman', 'king&prince',
  'twice', 'blackpink', 'exo', 'shinee', 'got7', 'stray kids', 'nct', 'ive',
  'le sserafim', 'tomorrow x together', 'txt', 'monsta x', 'astro', 'itzy',
  '嵐', 'smap', 'tokio', 'v6', 'kinki kids', 'kat-tun', 'hey!say!jump',
  'sexy zone', 'なにわ男子', 'travis japan', 'sixtones',
].map(a => a.toLowerCase());

/**
 * Pure-100 純度フィルター — 全モード共通で適用する最終純化層。
 *
 * ① プライマリアンカー（rawSeeds[0]）のトークンが
 *    タイトルに「すべて」含まれていることを要求する（AND）。
 * ② タイトル内でアンカーより前に「他の既知アーティスト」が
 *    主語として登場する記事は冷徹にドロップ（主語位置チェック）。
 * ③ アンカーがタイトルに存在しない場合、description に全語含まれれば許容。
 *
 * 汎用カテゴリ語（「スニーカー」「おもちゃ」等 = アンカー長 > 6 かつ
 * 複合語の場合）は過度なドロップを避けるため ① のみ適用する。
 *
 * @param {object[]} items
 * @param {string[]} rawSeeds  ユーザー入力の生キーワード（展開前）
 * @returns {object[]}
 */
function applyPurityFilter(items, rawSeeds) {
  if (!rawSeeds || rawSeeds.length === 0) return items;

  // 先頭シードを「主アンカー」として採用
  const anchor = rawSeeds[0].trim();
  if (!anchor) return items;

  const anchorTokens = anchor.split(/\s+/).filter(Boolean).map(t => t.toLowerCase());
  if (anchorTokens.length === 0) return items;

  // 固有名詞モード判定：短い単語（≤10文字）ならエンティティ扱い → 主語位置チェックも実施
  const isEntity = anchor.length <= 10;

  return items.filter(item => {
    const titleL = (item.title       || '').toLowerCase();
    const descL  = (item.description || '').toLowerCase();

    // ── ①：アンカー全トークンがタイトルに含まれる（AND 必須）──
    const allInTitle = anchorTokens.every(t => titleL.includes(t));

    if (!allInTitle) {
      // タイトルにない → description に全語あれば最低限許容
      return anchorTokens.every(t => descL.includes(t));
    }

    // ── ②：主語位置チェック（エンティティ専用）──────────────
    // アンカーより前に「他の既知アーティスト」が登場する記事は主語が違う → ドロップ
    if (isEntity) {
      const primaryToken = anchorTokens[0]; // 先頭語 = 主体（例: 'bts'）
      const primaryPos   = titleL.indexOf(primaryToken);

      const hijackedByOther = ALL_KNOWN_ARTISTS_LOWER.some(other => {
        if (other === primaryToken) return false;           // 自分自身は除外
        if (anchorTokens.includes(other)) return false;    // アンカー内語も除外
        const otherPos = titleL.indexOf(other);
        return otherPos !== -1 && otherPos < primaryPos;   // 他者が先行 → NG
      });

      if (hijackedByOther) return false;
    }

    return true;
  });
}

/**
 * 記事の「温度」スコアを計算する。
 * - 48時間以内の新着はノイズ判定を完全スキップ（鮮度最優先）
 * - ユーザーが検索したキーワードはノイズ免責対象
 *
 * @param {{ title: string, pubDate: string }} item
 * @param {string[]} [userSeeds]  ユーザー入力キーワード（検索キーワード免責に使用）
 * @returns {number}  -1 = 除外、0以上 = 表示対象（高いほど優先）
 */
function scoreTemperature(item, userSeeds = []) {
  const title = item.title || '';
  const ageMs = Date.now() - (item.pubDate ? new Date(item.pubDate).getTime() : 0);
  const ageH  = Math.max(0, ageMs / 3600000);

  // 【最重要】48時間以内ならノイズ判定（検閲）を完全にスキップ
  const isVeryFresh = ageH < 48;
  if (!isVeryFresh) {
    const seedTokens = userSeeds.flatMap(s => s.toLowerCase().split(/\s+/)).filter(Boolean);
    const effectiveNoise = TEMP_NOISE_WORDS.filter(w => !seedTokens.includes(w.toLowerCase()));
    if (effectiveNoise.some(w => title.includes(w))) return -1;
  }

  // スコア計算：48時間以内は 80点以上の高得点を維持
  let score = ageH < 6 ? 200 : ageH < 24 ? 100 : ageH < 48 ? 80 : ageH < 72 ? 40 : 2;
  TEMP_SIGNAL_WORDS.forEach(w => { if (title.includes(w)) score += 50; });
  return score;
}

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
  'BTS':         ['ウィバース', 'ユニバーサルミュージック', 'タワーレコード', 'チケット 抽選', 'チケット 販売', 'ライブ 公演'],
  'アイドル':    ['ユニバーサルミュージック', 'ソニーミュージック', 'タワーレコード'],
  'スニーカー':  ['ナイキ', 'アディダス', 'アトモス'],
  'ヴィトン':    ['ルイヴィトン', '正規品', '直営店'],
  'グッチ':      ['グッチ', '正規品', '直営店'],
  'カード':      ['トレカ', '遊戯王', 'ポケカ'],
  'ゲーム':      ['任天堂', 'プレイステーション', 'ニンテンドーストア'],
};

// ── 未知キーワードへの汎用 EC フォールバック ────────────────────────────
const GENERIC_EC_FALLBACK = ['amazon', 'rakuten', '公式通販'];

// ── グループ・メンバーマッピング（推し活モード専用）──────────────────────
// アーティスト名入力時に全メンバーのクエリを自動展開する
const ARTIST_MEMBERS = {
  'BTS':     ['RM', 'Jin', 'Suga', 'J-Hope', 'Jimin', 'V', 'Jungkook'],
  'AKB48':   ['前田敦子', '大島優子', '指原莉乃', '渡辺麻友', '山本彩'],
  'SKE48':   ['松井珠理奈', '松井玲奈', '須田亜香里'],
  'NMB48':   ['山本彩', '吉田朱里', '渋谷凪咲'],
  '乃木坂46': ['白石麻衣', '西野七瀬', '齋藤飛鳥', '生田絵梨花', '山下美月'],
  '日向坂46': ['小坂菜緒', '加藤史帆', '影山優佳', '齊藤京子'],
  '櫻坂46':  ['菅井友香', '守屋茜', '田村保乃', '藤吉夏鈴'],
  'SEVENTEEN':['エスクップス', 'ジョシュア', 'ウジ', 'ジュン', 'ホシ', 'ウォヌ', '울워누', 'DK', 'ミンギュ', '더원 ', 'ハン', 'ドギョム', 'ヴァーノン', 'スングァン'],
  'ENHYPEN': ['ジェイ', 'ジェイク', 'サンヒョン', 'ソンフン', 'ヒスン', 'ソヌ', 'ニキ'],
  'NewJeans': ['ミンジ', 'ヘリン', 'ダニエル', 'ヘイン', 'ハニ'],
  'aespa':   ['カリナ', 'ジゼル', 'ウィンター', 'ニンニン'],
  'SnowMan': ['岩本照', '深澤辰哉', '宮舘涼太', '向井康二', 'ラウール', '阿部亮平', '佐久間大介', '目黒蓮', '渡辺翔太'],
  'King&Prince': ['永瀬廉', '平野紫耀', '岸優太', '高橋海人'],
};

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
      model: getGeminiModel(),
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

// ── 公式ページ・告知ページで多用される語句（モジュールスコープ定数）────────
const INTEL_SUFFIXES = [
  '新作 限定',
  '予約 発表',
  '在庫 再販',
  '告知 案内',
  'ONLINE 販売決定',
  '特設ページ 公式',
];

/**
 * ブランド名単体（スペースなし）を複数の複合クエリへ展開する。
 * 英語名付加 → 行動語クエリ → 聖地店名 → AI 推論の順で拡張。
 * Google News RSS で確実に機能する純テキストクエリのみ使用。
 *
 * @param {string[]} seeds
 * @param {string}   [mode='']  'trend' なら新作/予約ブーストを付加
 * @returns {Promise<string[]>}
 */
async function expandKeywords(seeds, mode = '') {
  const isTrend = (mode === 'trend' || mode === 'newitem'); // 後方互換

  // モード別ブーストサフィックス（newitem/stock は空文字 = ブーストなし）
  const BOOST_SUFFIX = MODE_BOOST[mode] || '';

  // oshi モード：グループ名からメンバーを自動展開して追加（同期処理）
  const oshiSeeds = [...seeds];
  if (mode === 'oshi') {
    for (const seed of seeds) {
      const members = ARTIST_MEMBERS[seed];
      if (members) {
        members.slice(0, 3).forEach(m => {
          if (!oshiSeeds.includes(m)) oshiSeeds.push(m + ' ' + seed);
        });
      }
    }
  }

  // 全シードを Promise.all で並列展開（Gemini 呼び出しがある場合の直列ボトルネックを解消）
  const targetSeeds = mode === 'oshi' ? oshiSeeds : seeds;
  const perSeedResults = await Promise.all(targetSeeds.map(async (seed) => {
    const result = [seed];
    if (!seed.includes(' ')) {
      // 1. 英語名クエリ
      const enName = JP_TO_EN[seed];
      if (enName) result.push(enName + ' 新作 限定');

      // 2. 汎用行動語クエリ
      for (const suf of INTEL_SUFFIXES) result.push(seed + ' ' + suf);

      // 3. 聖地店名クエリ（登録済み）または汎用 EC フォールバック
      const holy = CATEGORY_DOMAINS[seed] || GENERIC_EC_FALLBACK;
      for (const shop of holy) result.push(seed + ' ' + shop);

      // 4. AI 推論拡張（未知キーワードかつ環境変数で明示的に有効化時のみ）
      if (!CATEGORY_DOMAINS[seed] && process.env.GEMINI_SCOUT_ENABLED === 'true') {
        const aiSuggestions = await geminiExpandKeyword(seed);
        result.push(...aiSuggestions);
      }
    }
    return result;
  }));

  // flat → 重複除去 → MAX_EXPANDED でキャップ
  const seen = new Set();
  const raw = perSeedResults.flat().filter(q => seen.has(q) ? false : seen.add(q)).slice(0, MAX_EXPANDED);

  // ── 全クエリにノイズ除去 + カテゴリブーストを付加 ──────────────────
  // ブーストはベースの1単語シードのみ適用（既に行動語を含む複合クエリは除外）
  const hasBoostWord = (q) => TREND_BOOST_TERMS.some(w => q.includes(w));

  const expanded = raw.map(q => {
    // ── oshi モード 鉄則：各ワードをダブルクォートで囲い厳格フレーズ AND 検索 ──
    // 「BTS 特典」→ "BTS" "特典" -中古... （Google News フレーズ一致 AND）
    // ブーストサフィックスは付加しない（ユーザーが明示したキーワードが絞り込み条件）
    // oshi / campaign: 各ワードをダブルクォートで囲い厳格フレーズ AND 検索
    // "BTS" "抽選" 形式 → Google News がフレーズ一致でAND処理
    if (mode === 'oshi' || mode === 'campaign') {
      // "BTS" "グッズ" -中古... の形式で送信
      // ※ when:7d をクエリに埋め込むと Google News RSS が空レスポンスを返す（同 &when=2m と同現象）
      //   鮮度フィルタリングはフィルター①（pubDate チェック）が担当する
      const quotedWords = q.trim().split(/\s+/).filter(Boolean).map(w => `"${w}"`).join(' ');
      return `${quotedWords} ${NOISE_MINUS}`;
    }
    const shouldBoost = BOOST_SUFFIX && !hasBoostWord(q);
    const boosted = shouldBoost ? `${q} ${BOOST_SUFFIX}` : q;
    return `${boosted} ${NOISE_MINUS}`;
  });

  return expanded;
}

/**
 * HTTP ハンドラ（POST /api/scout）
 *
 * Body（省略可）:
 *   { keywords?: string[], mode?: 'trend' | 'stock', limit?: number }
 *   mode='trend'  → 新作・予約・キャンペーンブースト付加
 *   limit         → 温度スコア上位 N 件（デフォルト 10）
 */
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const body        = req.method === 'POST' ? (req.body || {}) : {};
  const mode        = body.mode || 'trend';                          // デフォルトは trend モード
  const limit       = Math.min(Number(body.limit) || 10, 50);        // 最大50件まで
  const bypassDedup = Boolean(body.bypassDedup);                     // 手動検索時は Redis dedup をバイパス

  // rawSeeds を保持（oshi 鉄の掟フィルター用）
  const rawSeeds    = resolveSeeds(body.keywords);
  const seeds       = await expandKeywords(rawSeeds, mode);

  // ── デバッグログ：展開クエリを全開示 ──
  console.log(`[scout] mode=${mode} limit=${limit} bypass=${bypassDedup} 展開クエリ (${seeds.length}本): ${seeds.map(s => `"${s}"`).join(' | ')}`);

  const { items, errors, totalFoundInFeed } = await scanAll(seeds, bypassDedup);

  // ── 監督命令：Google News リンクを直リンクへ浄化（広告遮断の最初の砦） ──
  // 8秒の打ち切りレース：解決できた分だけ採用、間に合わなかったものは resolveOnClient: true。
  // 「70点を8秒で」が RE-EYE-HUB の道具としての正解。
  const CONCURRENCY = 4;
  const cleanedItems = await (async () => {
    const out = items.map(it => ({ ...it, resolveOnClient: true })); // 全件デフォルト：未解決
    let idx = 0;
    const workers = new Array(Math.min(CONCURRENCY, items.length)).fill(0).map(async () => {
      while (idx < items.length) {
        const cur = idx++;
        const it  = items[cur];
        if (!it || !it.url) { out[cur] = it; continue; }
        try {
          const { sourceUrl, newsUrl } = await resolveGoogleNewsToSource(it.url, { timeoutMs: 3000 });
          if (sourceUrl) {
            const urlChanged = sourceUrl !== it.url;
            out[cur] = { ...it, url: sourceUrl, newsUrl: urlChanged ? newsUrl : undefined, sourceUrl };
          }
        } catch (_) { /* out[cur] は既に resolveOnClient: true */ }
      }
    });
    await Promise.race([
      Promise.all(workers),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
    return out;
  })();

  // ── 冷徹フィルター：中古・オークション・禁止ドメインを全滅させる ──────────
  const noiseFiltered = filterNoise(cleanedItems);

  // ── 温度スコアリング（キーワード免責を有効化）────────────────────────────
  // isPriority: 全キーワードが含まれる = お宝確定 → フロントで黄色ハイライト
  const seedTokens = rawSeeds.flatMap(s => s.toLowerCase().split(/\s+/)).filter(Boolean);
  let scored = noiseFiltered.map(item => {
    const temp = scoreTemperature(item, rawSeeds);
    const titleL = (item.title || '').toLowerCase();
    const urlIsPriority   = isShopOrOfficialUrl(item.url);
    const titleIsPriority = seedTokens.length > 0 && seedTokens.every(t => titleL.includes(t));
    const isPriority      = urlIsPriority || titleIsPriority;
    return { ...item, temperature: temp, isPriority };
  }).filter(item => item.temperature >= 0);

  // ── oshi / campaign 共通 鉄の掟（5段フィルター）────────────────────────
  // フィルター①: 60日以内 pubDate 鮮度フィルター（oshi / campaign 一律）
  // フィルター②: タイトル中の旧西暦スキャン（URL は除外）
  // フィルター③: 全語タイトル AND 一致（アーティスト名＋チップ 両方必須）
  // フィルター④: 他の既知アーティストが主語の記事を排除（oshi 専用）
  // フィルター⑤: Jaccard 類似度 80% 以上の重複を最新1件に集約
  if (mode === 'oshi' || mode === 'campaign') {
    const searchTerms = rawSeeds
      .flatMap(s => s.trim().split(/\s+/))
      .filter(Boolean)
      .map(t => t.toLowerCase());

    const NOW_TS   = Date.now();
    // oshi / campaign ともに一律「過去60日」（Deep Recon 公式スペック）
    const FRESH_D  = 60 * 24 * 60 * 60 * 1000;
    const CURR_YR  = new Date().getFullYear(); // 2026

    // ── フィルター①：鮮度チェック（oshi / campaign ともに60日）──────────────
    const beforeFresh = scored.length;
    scored = scored.filter(item => {
      if (!item.pubDate) return true; // pubDate 欠如は通す（件数枯渇防止）
      const age = NOW_TS - new Date(item.pubDate).getTime();
      return age <= FRESH_D;
    });

    // ── フィルター②：タイトル中の旧西暦スキャン ─────────────────────────────
    // タイトルに 2024年以前の西暦が含まれる記事を破棄（古いキャッシュ記事の遮断）。
    // ※ URL はソースURL（/2024/12/article.html 等）に年号が含まれることが多く
    //   正当な新着記事を誤ブロックする原因になるため検査対象から除外する。
    const OLD_YEAR_RE = /\b(19\d{2}|200\d|201\d|202[0-4])\b/;
    const beforeYear = scored.length;
    scored = scored.filter(item => !OLD_YEAR_RE.test(item.title || ''));

    if (searchTerms.length > 0) {
      const primaryArtist = searchTerms[0]; // 先頭語 = アーティスト名

      // ── フィルター③：全語タイトル AND 一致（ノイズ根絶） ──────────────────
      const before3 = scored.length;
      scored = scored.filter(item => {
        const title = (item.title || '').toLowerCase();
        return searchTerms.every(term => title.includes(term));
      });

      // ── フィルター④：他の既知アーティストが主語の記事を排除（oshi 専用） ──
      const before4 = scored.length;
      if (mode === 'oshi') {
        const knownOtherArtists = Object.keys(ARTIST_MEMBERS)
          .filter(a => a.toLowerCase() !== primaryArtist)
          .map(a => a.toLowerCase());

        scored = scored.filter(item => {
          const title = (item.title || '').toLowerCase();
          const primaryPos = title.indexOf(primaryArtist);
          if (primaryPos === -1) return false;
          return !knownOtherArtists.some(other => {
            const otherPos = title.indexOf(other);
            return otherPos !== -1 && otherPos < primaryPos;
          });
        });
      }

      // ── フィルター⑤：Jaccard 類似度 80% 以上の重複を最新1件に集約 ──────────
      // 日本語タイトルの文字 bigram でジャカード類似度を算出。
      // Yahoo/ライブドア/リアルサウンド等が同一ネタを配信しても最新1件のみ表示。
      const normTitle = (t) =>
        (t || '')
          .replace(/\s*[-|｜：:]\s*[^\s-|｜：:]{2,20}$/, '') // 末尾の "- 媒体名" 除去
          .replace(/[「」『』【】〔〕()（）!！?？。、,\.…]/g, '')
          .replace(/\s+/g, '')
          .toLowerCase();

      const bigrams = (s) => {
        const set = new Set();
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
        return set;
      };

      const jaccardSim = (a, b) => {
        const ba = bigrams(a), bb = bigrams(b);
        if (ba.size === 0 && bb.size === 0) return 1;
        const inter = [...ba].filter(g => bb.has(g)).length;
        const union = new Set([...ba, ...bb]).size;
        return inter / union;
      };

      const SIMIL_THRESH = 0.80;
      const groups = []; // [{ normKey, item }]

      for (const item of scored) {
        const nk = normTitle(item.title);
        let merged = false;
        for (const grp of groups) {
          if (jaccardSim(grp.normKey, nk) >= SIMIL_THRESH) {
            // 同一クラスタ → 新しい方を残す
            const tNew = item.pubDate ? new Date(item.pubDate).getTime() : 0;
            const tOld = grp.item.pubDate ? new Date(grp.item.pubDate).getTime() : 0;
            if (tNew > tOld) { grp.item = item; grp.normKey = nk; }
            merged = true;
            break;
          }
        }
        if (!merged) groups.push({ normKey: nk, item });
      }
      const before5 = scored.length;
      scored = groups.map(g => g.item);

      console.log(
        `[scout] ${mode} 鉄の掟 (${searchTerms.join(' AND ')}): ` +
        `温度通過=${beforeFresh} → 7日鮮度=${beforeYear} → 旧年号除去=${before3} ` +
        `→ AND通過=${before4} → 他アーティスト排除=${before5} → Jaccard重複排除後=${scored.length} 件`
      );
    } else {
      console.log(`[scout] ${mode}: 7日鮮度=${beforeYear} (キーワードなし)`);
    }
  }

  // ── campaign モード専用：鮮度フィルタ & 締切優先ソート ──────────────────
  if (mode === 'campaign') {
    const NOW_MS = Date.now();
    const DAY_MS = 86400000;
    const WINDOW_MS = 60 * DAY_MS; // タイムウィンドウ：60日以内（Deep Recon）
    const DEADLINE_MS = 7 * DAY_MS; // 締切優先：7日以内

    // 60日以内の記事のみに絞る
    scored = scored.filter(item => {
      const pubMs = item.pubDate ? new Date(item.pubDate).getTime() : 0;
      return (NOW_MS - pubMs) <= WINDOW_MS;
    });

    // キーワードから締切日付を推定し、7日以内はボーナス +500
    const DEADLINE_PATTERNS = [/締切/, /応募締切/, /〆切/, /期限/, /まで/, /受付終了/];
    scored = scored.map(item => {
      const title = item.title || '';
      const hasDeadline = DEADLINE_PATTERNS.some(re => re.test(title));
      // pubDate が今日から7日以内かつ締切キーワードあり → 最優先
      const pubMs = item.pubDate ? new Date(item.pubDate).getTime() : 0;
      const isUrgent = hasDeadline && (NOW_MS - pubMs) <= DEADLINE_MS;
      return { ...item, temperature: item.temperature + (isUrgent ? 500 : 0), urgent: isUrgent };
    });

    // 価値フィルター：現金・高額・大量当選を優先（+100ボーナス）
    const HIGH_VALUE_WORDS = ['現金', '万円', 'ギフト券', '商品券', '高額', '大量当選', '100名', '200名', '500名'];
    scored = scored.map(item => {
      const title = item.title || '';
      const isHighValue = HIGH_VALUE_WORDS.some(w => title.includes(w));
      return { ...item, temperature: item.temperature + (isHighValue ? 100 : 0) };
    });
  }

  // ── Pure-100 純度フィルター（全モード共通・最終ゲート）──────────────────
  // oshi/campaign の5段フィルターを通過後、さらに「主語位置チェック」で
  // 他アーティストが主語の記事を根絶する。非 oshi モードでも機能する。
  const beforePurity = scored.length;
  scored = applyPurityFilter(scored, rawSeeds);
  if (scored.length < beforePurity) {
    console.log(`[scout] Pure-100: "${rawSeeds[0]}" 純化 ${beforePurity} → ${scored.length} 件（${beforePurity - scored.length} 件ドロップ）`);
  }

  scored = scored
    .sort((a, b) => b.temperature - a.temperature)   // 高温度順
    .slice(0, limit);

  // ── 監督命令：レスポンス直前に pubDate ミリ秒降順で最終ソート ──
  // 温度スコアで上位 limit 件に絞った後、時系列を正確に並べ直す。
  scored.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : (a.createdAt || 0);
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : (b.createdAt || 0);
    return tb - ta;
  });

  const removedByNoise = items.length - scored.length;

  // ── デバッグログ：スキャン結果サマリー ──
  console.log(
    `[scout] feedTotal=${totalFoundInFeed} | dedup後=${items.length} | ` +
    `ノイズ除外=${removedByNoise} | 温度上位=${scored.length} | errors=${errors.length}`
  );
  if (errors.length > 0) errors.forEach(e => console.warn('[scout] error:', e));

  return res.status(200).json({
    ok:              true,
    newCount:        scored.length,
    items:           scored,
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

  // スケジューラーは newitem モード（商品名そのまま＋ノイズ排除）で巡回
  const seeds = await expandKeywords(resolveSeeds(customSeeds), 'newitem');
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
