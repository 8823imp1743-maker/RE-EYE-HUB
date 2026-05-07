import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkStock, normalize, matchShoeSize, matchClothingSize } from './simple-html-stock-check.js';

function pad(html) {
  return `${html}<p>${'pad '.repeat(120)}</p>`;
}

describe('stock check', () => {
  it('靴 OK', () => {
    const html = pad(`
      <div>26.5cm</div>
      <button>カートに入れる</button>
    `);
    assert.equal(checkStock(html, '26.5', 'shoe'), true);
  });

  it('在庫なし', () => {
    const html = pad(`
      <div>26.5cm</div>
      <div>在庫なし</div>
    `);
    assert.equal(checkStock(html, '26.5', 'shoe'), false);
  });
});

describe('simple-html-stock-check extra', () => {
  const htmlPad = pad(`
<html><body>
<div>お選びください 26.5cm</div>
<button>カートに入れる</button>
</body></html>`);

  it('靴: normalize 後でも十分な長さで true', () => {
    assert.equal(checkStock(htmlPad, '26.5', 'shoe'), true);
  });

  it('靴: OOS と購入党で false', () => {
    const html = pad('<html><body>26.5cm 在庫なし カートに入れる</body></html>');
    assert.equal(checkStock(html, '26.5', 'shoe'), false);
  });

  it('靴: カート文言なし false', () => {
    const html = pad('<html><body>26.5cm</body></html>');
    assert.equal(checkStock(html, '26.5', 'shoe'), false);
  });

  it('服: M + カート true', () => {
    const html = pad('<html><body><p>サイズ M</p><a>カートに入れる</a></body></html>');
    assert.equal(checkStock(html, 'M', 'clothing'), true);
  });

  it('normalize が script を除去', () => {
    const s = normalize('<script>evil</script><p>26.5cm カートに入れる</p>');
    assert.ok(!/evil/.test(s));
    assert.ok(/26\.5cm/.test(s));
  });

  it('matchShoeSize レンジ表記除外', () => {
    const t = normalize('<p>26.5cm～27cm</p>');
    assert.equal(matchShoeSize(t, '26.5'), false);
  });

  it('matchClothingSize XXL', () => {
    const t = normalize('<p>XXL サイズ カートに入れる</p>');
    assert.equal(matchClothingSize(t, 'XXL'), true);
  });

  it('短文は checkStock false', () => {
    assert.equal(checkStock('<html>26.5cm カートに入れる</html>', '26.5', 'shoe'), false);
  });
});
