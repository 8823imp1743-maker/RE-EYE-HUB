import { fetchHtml, checkStock } from './simple-html-stock-check.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function random(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

export async function monitor(items, notify) {
  const targets = Array.isArray(items) ? items.slice(0, 10) : [];

  for (const item of targets) {
    await sleep(random(500, 1500));

    const html = await fetchHtml(item.url);
    if (!html) continue;

    const ok = checkStock(html, item.size, item.type);

    if (ok && typeof notify === 'function') {
      notify(item);
    }
  }
}
