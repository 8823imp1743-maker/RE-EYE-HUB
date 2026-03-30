/**
 * インテル・スカウター — トレンド記事の自律巡回エンジン
 *
 * Google News RSS を種（シード）キーワードで巡回し、
 * 未見の記事を新着として返す。Redis で重複排除（7日 TTL）。
 *
 * 品番未定の「予備軍」段階では記事タイトル・URL を
 * 仮のターゲットとしてキャッシュし、scouter API へ返す。
 */

import { createHash } from 'crypto';
import { getRedis }   from './redis.js';
import { stealthHeaders } from './stealth.js';

// Google News RSS（日本語、API キー不要）
// ※ &when=2m は未公式パラメータで空レスポンス原因になるため削除
const GOOGLE_NEWS_RSS =
  'https://news.google.com/rss/search?q={KEYWORD}&hl=ja&gl=JP&ceid=JP:ja';

// Redis キー プレフィックス
const INTEL_PREFIX = 'intel:seen:';

// 重複排除 TTL（60 日 — 索敵深度に合わせて延長）
const DEDUP_TTL_SEC = 60 * 24 * 60 * 60;

/**
 * 1 つのキーワードで Google News RSS を巡回し、新着記事を返す。
 *
 * @param {string} keyword  検索キーワード（例: "スニーカー 新作"）
 * @returns {Promise<IntelItem[]>}
 */
export async function scanKeyword(keyword) {
  const url = GOOGLE_NEWS_RSS.replace('{KEYWORD}', encodeURIComponent(keyword));

  const res = await fetch(url, {
    headers: {
      ...stealthHeaders(keyword),
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(12000), // 12 秒タイムアウト
  });

  if (!res.ok) {
    console.error(`[rss-scanner] HTTP ${res.status} for "${keyword}" URL: ${url}`);
    throw new Error(`RSS fetch failed: HTTP ${res.status} (${keyword})`);
  }

  const xml      = await res.text();

  // デバッグ：レスポンス先頭300文字を記録（空 or エラーページ検知）
  console.log(`[rss-scanner] "${keyword}" response preview: ${xml.slice(0, 300).replace(/\s+/g, ' ')}`);

  const rawItems = parseRss(xml);
  const totalFromFeed = rawItems.length; // Redis 重複排除前の記事総数

  // デバッグ：キーワードごとの生ヒット数を記録
  console.log(`[rss-scanner] "${keyword}": フィード ${totalFromFeed} 件`);

  const redis    = getRedis();
  const newItems = [];

  for (const raw of rawItems) {
    const dedupKey = INTEL_PREFIX + createHash('sha256')
      .update(raw.title + raw.link)
      .digest('hex')
      .slice(0, 20);

    const seen = await redis.get(dedupKey);
    if (seen) continue;

    // 未見 → Redis に登録してから返す
    await redis.set(dedupKey, '1', { ex: DEDUP_TTL_SEC });

    newItems.push({
      id:          dedupKey,
      keyword,
      title:       raw.title,
      url:         raw.link,
      description: raw.description.slice(0, 200),
      pubDate:     raw.pubDate,
      source:      'google_news',
      status:      'pending',        // pending → フロントで NOTIFIED 扱い
      createdAt:   Date.now(),
    });
  }

  // 超速報ロジック：pubDate 降順（最新記事を先頭）でソートして返す
  newItems.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  console.log(`[rss-scanner] "${keyword}": 新着 ${newItems.length} 件（重複排除後）`);
  return { newItems, totalFromFeed };
}

/**
 * 複数キーワードを並列巡回し、全新着アイテムを返す。
 *
 * @param {string[]} keywords
 * @returns {Promise<{ items: IntelItem[], errors: string[] }>}
 */
export async function scanAll(keywords) {
  const results = await Promise.allSettled(
    keywords.map(kw => scanKeyword(kw))
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
 */
function parseRss(xmlText) {
  const items  = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRe.exec(xmlText)) !== null) {
    const chunk = match[1];
    const title       = cdataOrTag(chunk, 'title');
    const link        = plainTag(chunk, 'link') || cdataOrTag(chunk, 'guid');
    const description = cdataOrTag(chunk, 'description');
    const pubDate     = plainTag(chunk, 'pubDate');

    if (title && link) {
      items.push({ title, link, description, pubDate });
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
