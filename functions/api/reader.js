/**
 * POST /api/reader  → URL 解決のみ
 *   { url } → { ok, sourceUrl, proxyUrl }
 *   SNS URL → { ok, sourceUrl, title, text, imageUrl, siteName, extractMethod:'sns-ogp' }
 *
 * GET  /api/reader  → SHIELD MODE HTML プロキシ
 *   ?url=...  X-Frame-Options 等のブロックヘッダーを削除し、
 *             AD_ERASER_CSS + base タグを注入して HTML をそのまま返す。
 *             Readability は使わない。元ページをそのまま表示する。
 */

import { httpsFetch }                from '../lib/http.js';
import { resolveGoogleNewsToSource } from '../lib/google-news.js';
import { stealthHeaders }            from '../lib/stealth.js';

// ── AD 遮断 CSS ──────────────────────────────────────────────────────────────
// サーバー側で <head> 直後に注入する。JS は allow-scripts で許可するが
// allow-autoplay を付与しないため動画の自動再生はブラウザが物理ブロックする。
const SHIELD_CSS = [
  // 動画・音声（autoplay は sandbox 側でも物理ブロック済み）
  'video,audio{display:none!important}',
  // iframe ベース広告
  'iframe[src*="doubleclick"],iframe[src*="googlesyndication"],iframe[src*="amazon-adsystem"]{display:none!important}',
  // クラス・ID 広告パターン
  '[class*=" ad"],[class^="ad-"],[class*="-ad"],[class*="_ad_"],[id^="ad-"],[id*="-ad-"]{display:none!important}',
  '[class*="AdS"],[class*="AdB"],[class*="AdC"],[class*="adslot"],[class*="adunit"]{display:none!important}',
  '.adsbygoogle,ins.adsbygoogle,ins[data-ad-slot]{display:none!important}',
  '[class*="advertisement"],[id*="advertisement"]{display:none!important}',
  '[class*="sponsor"],[id*="sponsor"],[class*="promo"],[id*="promo"]{display:none!important}',
  '[class*="affiliate"]{display:none!important}',
  // バナー
  '[class*="banner"],[id*="banner"]{display:none!important}',
  // ポップアップ・オーバーレイ
  '[class*="popup"],[id*="popup"]{display:none!important}',
  '[class*="overlay"],[id*="overlay"]{display:none!important}',
  // Cookie / GDPR / ニュースレター
  '[class*="cookie"],[id*="cookie"],[class*="gdpr"],[id*="gdpr"]{display:none!important}',
  '[class*="newsletter"],[id*="newsletter"]{display:none!important}',
  // fixed 広告帯（ページ直下の fixed div）
  'body>div[style*="position: fixed"],body>div[style*="position:fixed"]{display:none!important}',
  // data 属性ベース
  '[data-ad],[data-adunit],[data-dfp],[data-slot]{display:none!important}',
].join('');

// レスポンスから削除するブロックヘッダー
const STRIP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'x-content-security-policy',
  'x-webkit-csp',
  'x-xss-protection',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
]);

const UNTRUSTED_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'amazon-adsystem.com',
  'adservice.google.', 'googleadservices.', 'googletagmanager.com',
];
function isProbablyAdDomain(hostname) {
  const h = String(hostname || '').toLowerCase();
  return UNTRUSTED_DOMAINS.some(d => h.includes(d));
}

// ── SNS OGP 軽量抽出（X / Instagram）────────────────────────────────────────
function isSnsUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return h === 'x.com' || h === 'twitter.com' || h === 'instagram.com';
  } catch { return false; }
}

function extractOgp(html) {
  const get = (...names) => {
    for (const name of names) {
      const re = [
        new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"'<>]{1,2000})["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"'<>]{1,2000})["'][^>]+(?:property|name)=["']${name}["']`, 'i'),
      ];
      for (const r of re) {
        const m = r.exec(html);
        if (m?.[1]?.trim()) return m[1].trim();
      }
    }
    return '';
  };
  return {
    title:    get('og:title',       'twitter:title'),
    text:     get('og:description', 'twitter:description', 'description'),
    imageUrl: get('og:image',       'twitter:image',       'twitter:image:src'),
    siteName: get('og:site_name'),
  };
}

async function fetchSnsOgp(sourceUrl) {
  try {
    const r = await httpsFetch(sourceUrl, {
      method: 'GET', timeoutMs: 12000, maxRedirects: 5,
      headers: {
        'User-Agent':      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept':          'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
      },
    });
    if (r.statusCode < 200 || r.statusCode >= 300) return null;
    const ogp = extractOgp(r.body || '');
    if (!ogp.title && !ogp.text && !ogp.imageUrl) return null;
    return { title: ogp.title, text: ogp.text, imageUrl: ogp.imageUrl, siteName: ogp.siteName };
  } catch { return null; }
}

// ────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {

  // ── GET: SHIELD MODE HTML プロキシ ────────────────────────────────────────
  if (req.method === 'GET') {
    const rawUrl = String(req.query?.url || '').trim();
    if (!/^https?:\/\//i.test(rawUrl)) return res.status(400).send('Invalid url');

    let target;
    try { target = new URL(rawUrl); } catch { return res.status(400).send('Invalid url'); }
    if (isProbablyAdDomain(target.hostname)) return res.status(403).send('Blocked domain');

    try {
      const r = await httpsFetch(rawUrl, {
        method: 'GET', timeoutMs: 15000, maxRedirects: 7,
        headers: stealthHeaders(),
      });
      if (r.statusCode < 200 || r.statusCode >= 300) return res.status(502).send('Fetch failed');

      // <base> で相対URL を元ドメインに解決 + SHIELD_CSS を注入
      const baseOrigin = target.origin + '/';
      const shield = `<base href="${baseOrigin.replace(/"/g, '&quot;')}"><style id="re-eye-shield">${SHIELD_CSS}</style>`;

      let html = r.body || '';
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/(<head[^>]*>)/i, `$1${shield}`);
      } else {
        html = `<head>${shield}</head>` + html;
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache');
      // X-Frame-Options は意図的にセットしない（自分自身の iframe に返すため）
      return res.status(200).send(html);

    } catch (e) {
      console.error('[reader/shield]', e.message);
      return res.status(502).send('Proxy error');
    }
  }

  // ── POST: URL 解決 ────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  const url = String((req.body || {}).url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'Invalid url' });

  const { sourceUrl, resolveError } = await resolveGoogleNewsToSource(url, { timeoutMs: 12000 });
  if (resolveError || !sourceUrl) {
    return res.status(200).json({ ok: true, resolveError: true, sourceUrl: null });
  }

  let u;
  try { u = new URL(sourceUrl); } catch {
    return res.status(400).json({ ok: false, error: 'Invalid resolved url', sourceUrl });
  }
  if (isProbablyAdDomain(u.hostname)) {
    return res.status(400).json({ ok: false, error: 'Blocked domain', sourceUrl });
  }

  // SNS → OGP 軽量抽出モード（X / Instagram はプロキシに向かない）
  if (isSnsUrl(sourceUrl)) {
    console.log(`[reader] SNS mode: ${sourceUrl.slice(0, 80)}`);
    const sns = await fetchSnsOgp(sourceUrl);
    if (sns) {
      return res.status(200).json({
        ok: true, sourceUrl,
        title: sns.title || '', text: sns.text || '',
        imageUrl: sns.imageUrl || '', siteName: sns.siteName || '',
        extractMethod: 'sns-ogp',
      });
    }
    console.log(`[reader] SNS OGP failed, falling to shield: ${sourceUrl.slice(0, 80)}`);
  }

  // 通常記事 → プロキシ URL を返す（クライアントが iframe.src にセットする）
  const proxyUrl = `/api/reader?url=${encodeURIComponent(sourceUrl)}`;
  return res.status(200).json({ ok: true, sourceUrl, proxyUrl });
}
