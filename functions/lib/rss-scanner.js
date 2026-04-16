/**
 * インテル・スカウター — トレンド記事の自律巡回エンジン
 *
 * Google News RSS を種（シード）キーワードで巡回し、
 * 未見の記事を新着として返す。Redis で重複排除（7日 TTL）。
 *
 * 品番未定の「予備軍」段階では記事タイトル・URL を
 * 仮のターゲットとしてキャッシュし、scouter API へ返す。
 */

import { createHash }             from 'crypto';
import { request as httpsRequest } from 'https';
import { createGunzip, createInflate } from 'zlib';
import { getRedis }    from './redis.js';
import { stealthHeaders } from './stealth.js';

// Google News RSS（日本語、API キー不要）
// ※ &when=2m は未公式パラメータで空レスポンス原因になるため削除
const GOOGLE_NEWS_RSS =
  'https://news.google.com/rss/search?q={KEYWORD}&hl=ja&gl=JP&ceid=JP:ja';

// Redis キー プレフィックス
const INTEL_PREFIX       = 'intel:seen:';   // URL+タイトル ハッシュ（60日 TTL）
const INTEL_TITLE_PREFIX = 'intel:title:';  // 正規化タイトル ハッシュ（7日 TTL）

// 重複排除 TTL
const DEDUP_TTL_SEC       = 60 * 24 * 60 * 60; // 60 日（URL+タイトル）
const TITLE_DEDUP_TTL_SEC = 7  * 24 * 60 * 60; // 7 日（正規化タイトル — 類似記事を抑制）

// pubDate 年齢フィルター：50日超の古い記事を除外（旧噂・古いニュースを排除）
const MAX_ITEM_AGE_MS = 50 * 24 * 60 * 60 * 1000;

/**
 * 1 つのキーワードで Google News RSS を巡回し、新着記事を返す。
 *
 * @param {string}  keyword       検索キーワード（例: "スニーカー 新作"）
 * @param {boolean} [bypassDedup] true の場合 Redis 重複チェックをスキップ（手動検索専用）
 * @returns {Promise<IntelItem[]>}
 */
export async function scanKeyword(keyword, bypassDedup = false) {
  const url = GOOGLE_NEWS_RSS.replace('{KEYWORD}', encodeURIComponent(keyword));

  // 動的ジッター（1〜3秒スタガー）でリクエスト開始タイミングを分散
  const jitterMs = Math.floor(1000 + Math.random() * 2000);
  await new Promise(r => setTimeout(r, jitterMs));

  // ── node:https で直接リクエスト（fetch/undici のブロック回避） ──────
  const xml = await httpsGet(url, {
    ...stealthHeaders(keyword),
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
  });
  console.log(`[rss-scanner] [STAGE1] "${keyword}" | bytes=${xml.length}`);
  console.log(`[rss-scanner] [STAGE1] preview: ${xml.slice(0, 400).replace(/\s+/g, ' ')}`);

  // XML でなく HTML が返ってきていないかチェック
  if (xml.trim().startsWith('<!DOCTYPE') || xml.trim().startsWith('<html')) {
    console.error(`[rss-scanner] [STAGE1] ⚠️ HTML レスポンス検知 — Google がボットブロックしている可能性: "${keyword}"`);
  }

  // ── [STAGE 2] パース直後 ────────────────────────────────────────
  const rawItems = parseRss(xml);
  const totalFromFeed = rawItems.length; // Redis 重複排除前の記事総数
  console.log(`[rss-scanner] [STAGE2] parseRss → ${totalFromFeed} items for "${keyword}"`);

  if (rawItems.length > 0) {
    rawItems.slice(0, 3).forEach((it, i) =>
      console.log(`[rss-scanner] [STAGE2] RAW[${i}] title="${it.title}" link="${it.link}" pubDate="${it.pubDate}"`)
    );
  } else {
    // <item> タグが存在するか確認
    const itemTagCount = (xml.match(/<item[\s>]/g) || []).length;
    console.warn(`[rss-scanner] [STAGE2] parseRss 0件 — XML内の<item>タグ数: ${itemTagCount}`);
    if (itemTagCount === 0) {
      // <entry> (Atom形式) チェック
      const entryCount = (xml.match(/<entry[\s>]/g) || []).length;
      console.warn(`[rss-scanner] [STAGE2] <entry>タグ数: ${entryCount} (Atom形式の可能性)`);
    }
  }

  // ── [STAGE 3] Redis 重複チェック（fail-open: Redis 接続失敗時は全件返す） ──
  let redis = null;
  let redisOk = true;
  try { redis = getRedis(); } catch (e) {
    console.warn('[rss-scanner] [STAGE3] Redis 初期化失敗 (fail-open):', e.message);
    redisOk = false;
  }

  const newItems = [];

  for (const raw of rawItems) {
    // ── pubDate 年齢フィルター（60日超の古い記事を除外） ──────────────
    if (raw.pubDate) {
      const age = Date.now() - new Date(raw.pubDate).getTime();
      if (age > MAX_ITEM_AGE_MS) continue;
    }

    // ── URL+タイトルハッシュ（一次dedup） ─────────────────────────────
    const dedupKey = INTEL_PREFIX + createHash('sha256')
      .update(raw.title + raw.link)
      .digest('hex')
      .slice(0, 20);

    // ── 正規化タイトルハッシュ（二次dedup — 同記事を別ソースから重複取得しない） ──
    // タイトル末尾の " - 媒体名" または " | 媒体名" を除去して正規化
    const normalizedTitle = raw.title
      .replace(/\s*[-|｜]\s*[^-|｜]{2,30}$/, '')  // "記事タイトル - Source Name" → "記事タイトル"
      .trim()
      .toLowerCase();
    const titleKey = INTEL_TITLE_PREFIX + createHash('sha256')
      .update(normalizedTitle)
      .digest('hex')
      .slice(0, 20);

    if (redisOk && redis && !bypassDedup) {
      try {
        // 一次dedup（URL+タイトル）
        const seen = await redis.get(dedupKey);
        if (seen) continue;

        // 二次dedup（正規化タイトル — 同内容を別媒体から取得した場合）
        const titleSeen = await redis.get(titleKey);
        if (titleSeen) continue;

        // 未見 → 両キーを Redis に登録
        await redis.set(dedupKey, '1', { ex: DEDUP_TTL_SEC });
        await redis.set(titleKey, '1', { ex: TITLE_DEDUP_TTL_SEC });
      } catch (e) {
        // Redis 接続エラー → fail-open（この件は重複排除なしで追加する）
        console.warn(`[rss-scanner] [STAGE3] Redis エラー (fail-open): ${e.message}`);
        redisOk = false; // 以降のループも Redis をスキップ
      }
    }

    newItems.push({
      id:           dedupKey,
      keyword,
      title:        raw.title,
      url:          raw.link,
      sourceDomain: raw.sourceDomain || '', // <source url> から取得したソースドメイン
      description:  raw.description.slice(0, 200),
      pubDate:      raw.pubDate,
      source:       'google_news',
      status:       'pending',
      createdAt:    Date.now(),
    });
  }

  // 超速報ロジック：pubDate 降順（最新記事を先頭）でソートして返す
  newItems.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  // ── [STAGE 3] Redis チェック直後 ───────────────────────────────
  const dedupFiltered = totalFromFeed - newItems.length;
  console.log(`[rss-scanner] [STAGE3] "${keyword}": 新着 ${newItems.length} 件 | Redis既読除外 ${dedupFiltered} 件 | フィード合計 ${totalFromFeed} 件`);
  return { newItems, totalFromFeed };
}

/**
 * 複数キーワードを並列巡回し、全新着アイテムを返す。
 *
 * @param {string[]} keywords
 * @param {boolean}  [bypassDedup]  true の場合 Redis 重複チェックをスキップ（手動検索専用）
 * @returns {Promise<{ items: IntelItem[], errors: string[] }>}
 */
export async function scanAll(keywords, bypassDedup = false) {
  const results = await Promise.allSettled(
    keywords.map(kw => scanKeyword(kw, bypassDedup))
  );

  const items  = [];
  const errors = [];
  let totalFoundInFeed = 0; // Google News が返した記事総数（重複排除前）

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      items.push(...r.value.newItems);
      totalFoundInFeed += r.value.totalFromFeed;
    } else {
      const msg = `[${keywords[i]}] ${r.reason?.message || 'Unknown error'}`;
      errors.push(msg);
      console.error('[rss-scanner]', msg);
    }
  });

  return { items, errors, totalFoundInFeed };
}

// ── RSS 2.0 パーサー（依存ゼロ・CDATA 対応） ─────────────────────────

/**
 * RSS 2.0 XML テキストを解析して <item> の配列を返す。
 * Google News RSS・一般的なメディア RSS に対応。
 * <item> タグの属性（rdf:about 等）を許容するよう強化済み。
 */
function parseRss(xmlText) {
  const items  = [];
  // <item> タグに属性が付いている場合も対応（例: <item rdf:about="...">）
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRe.exec(xmlText)) !== null) {
    const chunk = match[1];
    const title       = cdataOrTag(chunk, 'title');

    // <link> の取得: 通常テキスト → CDATA → <guid> の順で試行
    // Google News では <link>URL</link> だが稀に属性付きの場合もある
    const link        = plainTag(chunk, 'link')
                     || cdataOrTag(chunk, 'link')
                     || attrTag(chunk, 'guid', 'isPermaLink')  // isPermaLink="true" の場合
                     || cdataOrTag(chunk, 'guid');

    const description = cdataOrTag(chunk, 'description');
    const pubDate     = plainTag(chunk, 'pubDate');

    // <source url="https://..."> 属性 — Google News RSS がソースドメインをここに格納する
    // resolveGoogleNewsToSource が失敗した際のフォールバックヒントとして使用
    const sourceUrlMatch = chunk.match(/<source[^>]+url=["']([^"']+)["']/i);
    const sourceDomain   = sourceUrlMatch ? sourceUrlMatch[1].trim() : '';

    if (title && link) {
      items.push({ title, link, description: description || '', pubDate: pubDate || '', sourceDomain });
    } else {
      // title/link どちらかが取れなかった場合の診断ログ
      if (items.length === 0) {
        console.warn(`[rss-scanner] parseRss skip item: title="${title}" link="${link}" chunk[:150]="${chunk.slice(0, 150).replace(/\s+/g, ' ')}"`);
      }
    }
  }

  return items;
}

/** CDATA または通常テキストの値を取り出す */
function cdataOrTag(xml, tag) {
  // CDATA: <tag><![CDATA[...]]></tag>
  const cd = xml.match(new RegExp(
    `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`
  ));
  if (cd) return cd[1].trim();
  return plainTag(xml, tag);
}

/** 通常タグテキストを取り出す */
function plainTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`));
  return m ? m[1].trim() : '';
}

/**
 * 特定の属性が存在するタグのテキスト内容を取り出す。
 * <guid isPermaLink="true">URL</guid> のようなケースに対応。
 *
 * @param {string} xml
 * @param {string} tag
 * @param {string} attr  存在を確認する属性名（値は問わない）
 * @returns {string}
 */
function attrTag(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*${attr}[^>]*>([^<]+)<\\/${tag}>`));
  return m ? m[1].trim() : '';
}

// ── HTTPS ネイティブリクエスト（fetch/undici バイパス） ────────────────

/**
 * node:https を使って URL のレスポンスボディを文字列で返す。
 * gzip/deflate 自動展開対応。リダイレクトは最大5回まで追跡。
 * fetch() が Cloud Functions で接続失敗する場合の代替。
 *
 * @param {string} urlStr
 * @param {Record<string, string>} headers
 * @param {number}  [redirectsLeft=5]
 * @returns {Promise<string>}
 */
function httpsGet(urlStr, headers, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  {
        ...headers,
        'Accept-Encoding': 'gzip, deflate',
        'Connection':      'close',
      },
      timeout: 15000,
    };

    const req = httpsRequest(options, (res) => {
      // リダイレクト追跡（301/302/307/308）
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        const location = new URL(res.headers.location, urlStr).href;
        res.resume();
        return resolve(httpsGet(location, headers, redirectsLeft - 1));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`RSS fetch failed: HTTP ${res.statusCode} (${urlStr})`));
      }

      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      const chunks = [];

      if (encoding === 'gzip') {
        const gunzip = createGunzip();
        res.pipe(gunzip);
        gunzip.on('data', c => chunks.push(c));
        gunzip.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
        gunzip.on('error', reject);
      } else if (encoding === 'deflate') {
        const inflate = createInflate();
        res.pipe(inflate);
        inflate.on('data', c => chunks.push(c));
        inflate.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
        inflate.on('error', reject);
      } else {
        res.on('data', c => chunks.push(Buffer.from(c)));
        res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      }
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error',   reject);
    req.end();
  });
}

/**
 * @typedef {Object} IntelItem
 * @property {string} id          Redis キー（ユニーク）
 * @property {string} keyword     発生元キーワード
 * @property {string} title       記事タイトル
 * @property {string} url         記事 URL
 * @property {string} description 記事概要（200 文字以内）
 * @property {string} pubDate     RSS pubDate 文字列
 * @property {string} source      'google_news'
 * @property {string} status      'pending'
 * @property {number} createdAt   取得時刻（Unix ms）
 */
