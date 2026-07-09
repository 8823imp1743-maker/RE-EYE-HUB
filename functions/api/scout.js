/**
 * POST /api/scout
 * インテル・スカウター — オンデマンド巡回 API
 *
 * リクエスト Body（省略可）:
 *   { keywords?: string[], userId?: string }  **userId 必須に近い** — 付与時のみ Redis `user:settings` から
 *   靴 cm / 服を読み、シードへ `getUserSizeKeywordsForUser` で合成する。未送信だと在庫ニュース上乗せ
 *   `scoreInventoryNewsBonusForUser` も効かない。フロントは **必ず getUserId() を body に含める**こと。
 *   保存直後の次のスカウトから新サイズが反映される（毎回 Redis 直読、キャッシュなし）。
 *   `forChild: true` 時は子ども用の服・靴 cm のみをシードに注入（大人と混在しない; `/api/search` の forChild と同型）。
 *
 * レスポンス:
 *   { ok, newCount, items, errors, scannedAt }
 *
 * スケジューラー（index.js の scoutScheduler）からも同じロジックを使う。
 */

import { sanitizeUserId } from '../lib/user-settings.js';
import { scanAll, scanAllSequentialUntil } from '../lib/rss-scanner.js';
import { jitterDelay }         from '../lib/stealth.js';
import { filterNoise, QUERY_NOISE_MINUS } from '../lib/noise-filter.js';
import {
  getUserSizeKeywordsForUser,
  loadUserSettings,
  scoreInventoryNewsBonusForUser,
} from '../lib/user-size.js';

/** HTTP スカウトの鮮度窓（RSS・oshi 向け・最新特化） */
const SCOUT_LATEST_MS = 48 * 60 * 60 * 1000;
/** campaign のみ RSS / フィルター① をこの程度まで広げる（懸賞・予告の取りこぼし防止） */
const SCOUT_CAMPAIGN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Vercel 10 秒壁の前に必ず JSON を返す */
const SCOUT_HTTP_DEADLINE_MS = 7000;

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

/** 公式・大手販路に近いシグナル → 温度に上乗せ（素人記事を相対的に沈める） */
function officialPresenceBonus(item) {
  const u = ((item.url || '') + ' ' + (item.sourceDomain || '')).toLowerCase();
  const t = (item.title || '').toLowerCase();
  const hay = `${u} ${t}`;
  if (
    /公式|official|pr\s*times|prtimes\.|amazon\.co\.jp|楽天市場|yahoo\.co\.jp\/shopping|\.go\.jp\/|\.or\.jp\/|rakuten\.co\.jp\/|corp\.|brand\.jp/i.test(
      hay
    )
  ) {
    return 220;
  }
  return 0;
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
  QUERY_NOISE_MINUS +
  ' -SNKRDUNK -スニダン -買取 -事件 -株価' +
  ' -愛犬 -おばあちゃん -コラム -日記 -ブログ -感想 -紹介';

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
 * 英語名付加 → 行動語クエリ → 聖地店名（ルールベースのみ・Gemini 不使用）
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
      if (mode === 'campaign') {
        const words = q.trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) return `${NOISE_MINUS}`;
        if (words.length === 1) return `"${words[0]}" ${NOISE_MINUS}`;
        const primary = `"${words[0]}"`;
        const rest = words.slice(1).join(' ');
        return `${primary} ${rest} ${NOISE_MINUS}`;
      }
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

  try {
  const body        = req.method === 'POST' ? (req.body || {}) : {};
  const mode        = body.mode || 'trend';                          // デフォルトは trend モード
  const limit       = Math.min(Number(body.limit) || 10, 50);        // 最大50件まで
  /** API 呼び出しは既定で Redis 既読を無視し RSS を毎回生かける（batch のみ false を明示） */
  const bypassDedup = body.bypassDedup !== false;

  // rawSeeds を保持（oshi 鉄の掟フィルター用）。userId があれば靴/服文脈に応じてシードへサイズ注入
  // forChild: true のとき子ども用 childShoeSize / childClothSize のみ注入（大人と混在しない）
  const forChild = !!body.forChild;
  let rawSeeds = resolveSeeds(body.keywords);
  const scoutUserId = sanitizeUserId(typeof body.userId === 'string' ? body.userId.trim() : '') || '';
  if (scoutUserId) {
    rawSeeds = await getUserSizeKeywordsForUser(scoutUserId, rawSeeds, forChild);
  }

  const scoutSettings =
    scoutUserId ? await loadUserSettings(scoutUserId) : null;

  const seeds       = await expandKeywords(rawSeeds, mode);

  // ── デバッグログ：展開クエリを全開示 ──
  console.log(`[scout] mode=${mode} limit=${limit} bypass=${bypassDedup} 展開クエリ (${seeds.length}本): ${seeds.map(s => `"${s}"`).join(' | ')}`);

  const rssItemMaxAgeMs =
    mode === 'campaign' ? SCOUT_CAMPAIGN_WINDOW_MS : SCOUT_LATEST_MS;

  const scanDeadline = Date.now() + SCOUT_HTTP_DEADLINE_MS;
  const {
    items,
    errors,
    totalFoundInFeed,
    truncated: rssScanTruncated,
  } = await scanAllSequentialUntil(seeds, bypassDedup, scanDeadline, true, {
    maxItemAgeMs: rssItemMaxAgeMs,
  });

  // レイテンシ短縮：Google News の実 URL 解決は行わず、リンク＋タイトルのまま返す（クライアントで開く）
  const cleanedItems = items.map((it) => ({ ...it, resolveOnClient: true }));

  // ── 冷徹フィルター：中古・オークション・禁止ドメインを全滅させる ──────────
  const noiseFiltered = filterNoise(cleanedItems);

  // campaign：商取引シグナル無しは足切り（入荷・在庫・販売・抽選のいずれも無い記事は不要）
  let postCommerce = noiseFiltered;
  if (mode === 'campaign') {
    const CAMPAIGN_SIG = /入荷|在庫|販売|抽選|懸賞|プレゼント|キャンペーン|当選|応募|配布|無料|コラボ|記念/;
    postCommerce = noiseFiltered.filter((item) => {
      const hay = (item.title || '') + (item.description || '');
      return CAMPAIGN_SIG.test(hay);
    });
  }

  // ── 温度スコアリング（キーワード免責を有効化）────────────────────────────
  // isPriority: 全キーワードが含まれる = お宝確定 → フロントで黄色ハイライト
  const seedTokens = rawSeeds.flatMap(s => s.toLowerCase().split(/\s+/)).filter(Boolean);
  let scored = postCommerce.map(item => {
    const sizeStockBonus = scoutSettings ? scoreInventoryNewsBonusForUser(scoutSettings, item, forChild) : 0;
    const temp =
      scoreTemperature(item, rawSeeds) + officialPresenceBonus(item) + sizeStockBonus;
    const titleL = (item.title || '').toLowerCase();
    const urlIsPriority   = isShopOrOfficialUrl(item.url);
    const titleIsPriority = seedTokens.length > 0 && seedTokens.every(t => titleL.includes(t));
    const isPriority      = urlIsPriority || titleIsPriority;
    return {
      ...item,
      temperature: temp,
      isPriority,
      /** 設定サイズ×在庫ニュース一致の上乗せ（0 のときはキー省略に近いがデバッグのため常に数値） */
      sizeStockNewsBonus: sizeStockBonus,
    };
  }).filter(item => item.temperature >= 0);

  const withBonus = scored.filter((i) => (i.sizeStockNewsBonus || 0) > 0);
  const bonus900 = withBonus.filter((i) => (i.sizeStockNewsBonus || 0) >= 900);
  const sampleB = withBonus.slice(0, 10).map((i) => ({
    bonus: i.sizeStockNewsBonus,
    temp: i.temperature,
    title: (i.title || '').slice(0, 72),
  }));
  console.log(
    '[AUDIT][scout] sizeStockNewsBonus>0: ' +
      withBonus.length +
      '/' +
      scored.length +
      ' | >=900: ' +
      bonus900.length +
      ' | サンプル(最大10)=' +
      JSON.stringify(sampleB)
  );

  // ── oshi / campaign 共通 鉄の掟（5段フィルター）────────────────────────
  // フィルター①: pubDate 鮮度（oshi=48h / campaign=14 日・RSS maxItemAge と整合）
  // フィルター②: タイトル中の旧西暦スキャン（URL は除外）
  // フィルター③: oshi=全語 AND / campaign=先頭語必須＋残りのいずれか1語（緩和）
  // フィルター④: 他の既知アーティストが主語の記事を排除（oshi 専用）
  // フィルター⑤: Jaccard 類似度 80% 以上の重複を最新1件に集約
  if (mode === 'oshi' || mode === 'campaign') {
    const searchTerms = rawSeeds
      .flatMap(s => s.trim().split(/\s+/))
      .filter(Boolean)
      .map(t => t.toLowerCase());

    const NOW_TS   = Date.now();
    const FRESH_D  = mode === 'campaign' ? SCOUT_CAMPAIGN_WINDOW_MS : SCOUT_LATEST_MS;

    // ── フィルター①：鮮度チェック ───────────────────────────────────────────
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

      // ── フィルター③：タイトル一致（oshi 厳格 AND / campaign 緩和） ───────────
      const before3 = scored.length;
      scored = scored.filter(item => {
        const title = (item.title || '').toLowerCase();
        if (mode === 'campaign') {
          if (searchTerms.length === 0) return true;
          const primary = searchTerms[0];
          if (!title.includes(primary)) return false;
          if (searchTerms.length === 1) return true;
          return searchTerms.slice(1).some(term => title.includes(term));
        }
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
        `温度通過=${beforeFresh} → 48h鮮度=${beforeYear} → 旧年号除去=${before3} ` +
        `→ AND通過=${before4} → 他アーティスト排除=${before5} → Jaccard重複排除後=${scored.length} 件`
      );
    } else {
      console.log(`[scout] ${mode}: 48h鮮度=${beforeYear} (キーワードなし)`);
    }
  }

  // ── campaign モード専用：鮮度フィルタ & 締切優先ソート ──────────────────
  if (mode === 'campaign') {
    const NOW_MS = Date.now();
    const DAY_MS = 86400000;
    const WINDOW_MS = SCOUT_CAMPAIGN_WINDOW_MS; // campaign は 14 日窓（RSS と整合）
    const DEADLINE_MS = 7 * DAY_MS; // 締切優先：7日以内

    // 14 日以内の記事のみに絞る
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
    .sort((a, b) => b.temperature - a.temperature)   // 高温度順（sizeStockNewsBonus 込み）
    .slice(0, limit);

  // 温度（ユーザー別在庫×サイズボーナス含む）を最優先。同点のみ新しい pubDate を上に。
  scored.sort((a, b) => {
    const d = (b.temperature || 0) - (a.temperature || 0);
    if (d !== 0) return d;
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : (a.createdAt || 0);
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : (b.createdAt || 0);
    return tb - ta;
  });

  const removedByNoise = items.length - scored.length;

  const outBonus = scored.filter((i) => (i.sizeStockNewsBonus || 0) > 0);
  console.log(
    '[AUDIT][scout] 最終返却 最大' +
      limit +
      '件内: sizeStockNewsBonus>0 → ' +
      outBonus.length +
      ' 件 | 先頭3件=' +
      JSON.stringify(
        scored.slice(0, 3).map((i) => ({
          t: (i.temperature || 0),
          b: i.sizeStockNewsBonus || 0,
          title: (i.title || '').slice(0, 64),
        }))
      )
  );

  // ── デバッグログ：スキャン結果サマリー ──
  console.log(
    `[scout] feedTotal=${totalFoundInFeed} | dedup後=${items.length} | ` +
    `ノイズ除外=${removedByNoise} | 温度上位=${scored.length} | errors=${errors.length}`
  );
  if (errors.length > 0) errors.forEach(e => console.warn('[scout] error:', e));

  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  return res.status(200).json({
    ok:              true,
    newCount:        scored.length,
    items:           scored,
    errors,
    totalFoundInFeed,
    scannedAt:       Date.now(),
    debug: {
      latestWindowMs: mode === 'campaign' ? SCOUT_CAMPAIGN_WINDOW_MS : SCOUT_LATEST_MS,
      rssItemMaxAgeMs: rssItemMaxAgeMs,
      httpDeadlineMs: SCOUT_HTTP_DEADLINE_MS,
      rssScanTruncated,
      skippedNewsUrlResolve: true,
      bonusAudit: {
        itemsWithSizeStockNewsBonus: outBonus.length,
        top3: scored.slice(0, 3).map((i) => ({
          temperature: i.temperature,
          sizeStockNewsBonus: i.sizeStockNewsBonus || 0,
        })),
      },
    },
  });
  } catch (e) {
    console.error('[scout] phase=handler', {
      message: e?.message || String(e),
      stack: e?.stack ? String(e.stack).slice(0, 1200) : undefined,
    });
    throw e;
  }
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
