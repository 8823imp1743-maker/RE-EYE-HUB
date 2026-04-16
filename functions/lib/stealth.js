/**
 * ステルス・コア — 偵察機の隠蔽ロジック
 *
 * ショップ側のボット検知を無力化するための3層防御:
 *   1. Jitter        : 実行間隔に ±12% のゆらぎを付与
 *   2. Multi-Persona : User-Agent をリクエストごとにローテーション
 *   3. Referer 偽装  : Google / 価格比較サイトからの流入を装う
 */

// ── User-Agent プール ────────────────────────────────────────────────
const USER_AGENTS = [
  // Chrome Desktop (Windows)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // Chrome iPhone
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.60 Mobile/15E148 Safari/604.1',
  // Safari iPhone
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
  // Yahoo! ブラウザ (Android)
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 YJApp-ANDROID jp.co.yahoo.android.yjtop/3.89.0',
  // Firefox Desktop
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  // Edge Desktop
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  // Chrome Android
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
];

// ── Referer プール（google.co.jp を先頭に固定） ──────────────────────
const REFERER_BASES = [
  'https://www.google.co.jp/search?q=',
  'https://www.google.co.jp/',
  'https://www.google.com/search?q=',
  'https://search.yahoo.co.jp/search?p=',
  'https://www.bing.com/search?q=',
  'https://kakaku.com/search/search.aspx/?query=',
];

// ── Jitter ─────────────────────────────────────────────────────────

/**
 * 基準インターバルに ±pct のジッターを付与した ms を返す。
 * Cloud Scheduler / setTimeout に渡す直前にラップして使う。
 *
 * @param {number} baseMs  基準インターバル（ミリ秒）
 * @param {number} pct     ゆらぎ幅（デフォルト 0.12 = ±12%）
 * @returns {number}
 */
export function withJitter(baseMs, pct = 0.12) {
  const delta = baseMs * pct;
  return Math.round(baseMs + (Math.random() * 2 - 1) * delta);
}

/**
 * 動的ジッター（±30〜60秒）— リクエスト間の規則性を完全に排除する。
 * 各プランの監視間隔に加算する絶対時間ゆらぎ（ms）を返す。
 * 符号はランダムで、絶対値は 30〜60秒 の範囲。
 *
 * @param {number} minSec 最小ゆらぎ秒数（デフォルト 30）
 * @param {number} maxSec 最大ゆらぎ秒数（デフォルト 60）
 * @returns {number}  ミリ秒（正負どちらも）
 */
export function dynamicJitter(minSec = 30, maxSec = 60) {
  const sign  = Math.random() < 0.5 ? 1 : -1;
  const range = (maxSec - minSec) * 1000;
  const abs   = Math.floor(minSec * 1000 + Math.random() * range);
  return sign * abs;
}

/**
 * スケジューラー起動直後に呼び出す非同期ジッター遅延。
 * Cloud Functions は同時刻に一斉起動するため、この遅延で負荷を分散する。
 *
 * @param {number} maxDelayMs 最大遅延（デフォルト 3 分）
 */
export function jitterDelay(maxDelayMs = 3 * 60 * 1000) {
  const delay = Math.floor(Math.random() * maxDelayMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

// ── Multi-Persona ───────────────────────────────────────────────────

/**
 * ランダムな User-Agent を返す（リクエストごとに呼び出す）
 * @returns {string}
 */
export function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Referer 偽装 ────────────────────────────────────────────────────

/**
 * キーワードを含むランダムな Referer URL を返す。
 * 検索エンジン・価格比較サイトからの自然流入を装う。
 *
 * @param {string} keyword 検索キーワード
 * @returns {string}
 */
export function randomReferer(keyword = '') {
  const base = REFERER_BASES[Math.floor(Math.random() * REFERER_BASES.length)];
  return base + encodeURIComponent(keyword);
}

// ── ステルスヘッダー生成 ────────────────────────────────────────────

/**
 * ステルスリクエスト用の HTTP ヘッダーセットを生成する。
 * fetch() の headers オプションにそのまま渡す。
 *
 * @param {string} keyword リファラ生成に使用するキーワード
 * @returns {Record<string, string>}
 */
export function stealthHeaders(keyword = '') {
  return {
    'User-Agent':      randomUserAgent(),
    'Referer':         randomReferer(keyword),
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    // Sec-Fetch-* はブラウザ専用ヘッダ — サーバーサイドから送るとブロックされるため削除
  };
}
