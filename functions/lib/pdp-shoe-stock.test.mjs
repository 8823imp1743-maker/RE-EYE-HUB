/**
 * PDP 在庫 strict / fail-close の回帰テスト
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePdpHtmlForShoeCm,
  analyzePdpHtmlForGenericStructuralBuy,
  normalizeRakutenUrl,
} from './pdp-shoe-stock.js';

const longHtml = (bodyInner) => {
  const head = `<!DOCTYPE html><html><head><title>x</title>
<meta name="description" content="【22cm-29cm】 ダミー" /></head><body>`;
  const foot = `</body></html>`;
  const mid = String(bodyInner);
  let s = head + mid + foot;
  if (s.length < 500) {
    const need = 500 - s.length;
    const open = '<span class="pdp-pad" hidden>';
    const close = '</span>';
    const pCount = Math.max(0, need - open.length - close.length);
    s = head + mid + `${open}${'p'.repeat(pCount)}${close}` + foot;
  }
  return s;
};

describe('normalizeRakutenUrl', () => {
  it('unfolds hb.afl pc= to product URL', () => {
    const u =
      'https://hb.afl.rakuten.co.jp/xxx?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fa%2Fb%2F';
    const o = normalizeRakutenUrl(u);
    assert.ok(String(o).includes('item.rakuten.co.jp'));
  });
});

describe('analyzePdpHtmlForShoeCm fail-close', () => {
  it('URL は見ない。Yahoo でも cm単位明示＋購入フレーズで dom_structural', () => {
    const html = longHtml(`
<main>カートに入れる
<select><option>26.5cm</option><option>27.0cm</option></select>
</main>`);
    const r = analyzePdpHtmlForShoeCm(
      html,
      '26.5',
      'https://store.shopping.yahoo.co.jp/shop/p-xxx-265.html',
    );
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'dom_structural');
  });

  it('品切れ明示 → pdp_explicit_out_of_stock（構造一致があっても先に落とす）', () => {
    const html = longHtml(`
<main>品切れです
<select><option>26.5cm</option></select>
<button>カートに入れる</button>
</main>`);
    const r = analyzePdpHtmlForShoeCm(
      html,
      '26.5',
      'https://store.shopping.yahoo.co.jp/shop/x.html',
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'pdp_explicit_out_of_stock');
  });

  it('cmあり・同一コンテナに購入フレーズなし → no_structural_size', () => {
    const html = longHtml(`
<main>
<select><option>26.5cm</option></select>
<p>ご覧いただけます。</p>
</main>`);
    const r = analyzePdpHtmlForShoeCm(html, '26.5', 'https://example.com/p');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_structural_size');
  });

  it('構造サイズ選択 + カート → dom_structural', () => {
    const html = longHtml(`
<main>カートに入れる
<select><option>26.5cm</option><option>27.0cm</option></select>
</main>`);
    const r = analyzePdpHtmlForShoeCm(html, '26.5', 'https://example.com/p');
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'dom_structural');
  });

  it('数値のみ・cm/㎝ 単位なし → no_structural_size（旧「選択肢のみ」相当）', () => {
    const html = longHtml(`
<main>カートに入れる
<select><option>26.5</option><option>27.0</option></select>
</main>`);
    const r = analyzePdpHtmlForShoeCm(html, '26.5', 'https://zozo.jp/p/1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_structural_size');
  });

  it('同一 main 内に button サイズ表記 + カート文言 → dom_structural', () => {
    const html = longHtml(
      '<main><button type="button">26.5cm</button>カートに入れる</main>',
    );
    const r = analyzePdpHtmlForShoeCm(html, '26.5', 'https://example.com/p');
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'dom_structural');
  });

  it('div だけに data-size（クリック宿主なし）→ no_structural_size', () => {
    const html = longHtml(
      '<main>カートに入れる<div data-size="26.5cm"></div></main>',
    );
    const r = analyzePdpHtmlForShoeCm(html, '26.5', 'https://example.com/p');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_structural_size');
  });

  it('script のみ・購入文言ありでも構造無し → false', () => {
    const html = longHtml(
      '<script>var x={"size":"26.5"};</script><p>カートに入れる</p>',
    );
    const r = analyzePdpHtmlForShoeCm(html, '26.5', 'https://item.rakuten.co.jp/a/b/');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_structural_size');
  });

  it('HTML 短文 → fetch_fail_strict + retryable', () => {
    const r = analyzePdpHtmlForShoeCm('<html><body>short</body></html>', '26.5', 'https://a.com/');
    assert.equal(r.ok, false);
    assert.equal(r.pdpTentative, false);
    assert.equal(r.reason, 'fetch_fail_strict');
    assert.equal(r.retryable, true);
  });

  it('約26.5cm → 単一サイズとして採用しない（no_structural_size）', () => {
    const html = longHtml(
      '<main>カートに入れる 約26.5cm 選択可</main>',
    );
    const r = analyzePdpHtmlForShoeCm(html, '26.5', 'https://example.com/p');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_structural_size');
  });

  it('レンジのみ（単一 cm 字面なし）→ no_structural_size', () => {
    const html = longHtml(
      '<main>カートに入れる 対応【26cm-27cm】の靴です</main>',
    );
    const r = analyzePdpHtmlForShoeCm(html, '26.5', 'https://example.com/p');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_structural_size');
  });

  it('レンジ最大 < 希望 cm → size_range_excludes_target（構造判定前）', () => {
    const html = longHtml(
      '<main>カートに入れる 対応サイズ 22.0〜25.0cm<select><option>24.0cm</option><option>25.0cm</option></select></main>',
    );
    const r = analyzePdpHtmlForShoeCm(html, '26.5', 'https://example.com/p');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'size_range_excludes_target');
  });

  it('選択肢に希望 cm が無い → target_size_not_selectable', () => {
    const html = longHtml(
      '<main>カートに入れる<select><option>24.0cm</option><option>25.0cm</option><option>26.0cm</option></select></main>',
    );
    const r = analyzePdpHtmlForShoeCm(html, '26.5', 'https://example.com/p');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'target_size_not_selectable');
  });

  it('フラットに cm 無し・data-size に 26.5cm → サイズUI経路で dom_structural', () => {
    const html = longHtml(`<main>カートに入れる
<button type="button" data-size="26.5cm">選択</button>
</main>`);
    const r = analyzePdpHtmlForShoeCm(html, '26.5', 'https://example.com/p');
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'dom_structural');
  });
});

describe('analyzePdpHtmlForGenericStructuralBuy (v5 サイズなし PDP)', () => {
  it('main 用: 商域にカート導線 → dom_structural', () => {
    const html = longHtml(`<main><button type="button">カートに入れる</button></main>`);
    const r = analyzePdpHtmlForGenericStructuralBuy(html, 'https://example.com/sticker');
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'dom_structural');
  });

  it('品切れのみ → out_of_stock', () => {
    const html = longHtml(`<main>品切れです</main>`);
    const r = analyzePdpHtmlForGenericStructuralBuy(html, 'https://example.com/x');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'out_of_stock');
  });
});
