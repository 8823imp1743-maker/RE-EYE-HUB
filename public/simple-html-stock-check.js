// Mirror of functions/lib/simple-html-stock-check.js (browser ESM)

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/119 Safari/537.36',
];

function getUA() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

export function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalize(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchShoeSize(text, size) {
  const s = escapeReg(size);

  if (new RegExp(`${s}.*[-~〜\u301C\uFF5E].*`, 'i').test(text)) return false;

  const re = new RegExp(`(?<![0-9.])${s}(?:\\s*(?:cm|㎝))?(?![0-9.])`, 'i');
  return re.test(text);
}

export function matchClothingSize(text, size) {
  const s = String(size).toUpperCase();
  const re = new RegExp(`(^|\\s)${escapeReg(s)}(?=($|\\s|サイズ))`, 'i');
  return re.test(text);
}

export function checkStock(html, size, type) {
  if (!html || size == null || size === '') return false;

  const text = normalize(html);
  if (text.length < 200) return false;

  const hasSize =
    type === 'shoe' ? matchShoeSize(text, size) : type === 'clothing' ? matchClothingSize(text, size) : false;

  if (!hasSize) return false;

  const hasBuy =
    /カートに入れる|購入手続きへ|今すぐ購入|Add to Cart|Buy Now/i.test(text);

  const isOut = /在庫なし|売り切れ|SOLD\s?OUT|完売|取扱終了/i.test(text);

  if (!hasBuy || isOut) return false;

  const sizeRe = new RegExp(`(?<![0-9.])${escapeReg(size)}(?![0-9.])`);
  const match = text.match(sizeRe);
  if (!match || match.index == null) return false;

  const idx = match.index;

  const snippet = text.slice(Math.max(0, idx - 200), idx + 200);

  if (!/カートに入れる|購入|Add to Cart|Buy/i.test(snippet)) return false;

  return true;
}

export async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': getUA(),
        'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
      },
    });

    if (!res.ok) return null;

    const text = await res.text();
    if (!text || text.length < 300) return null;

    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
