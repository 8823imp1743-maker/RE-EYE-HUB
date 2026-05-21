import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctrVariant, buildStockMonitorCtr } from './notify-ctr.js';

test('ctrVariant はユーザー＋salt で固定', () => {
  assert.equal(ctrVariant('uid-42', 'salt-a'), ctrVariant('uid-42', 'salt-a'));
});

test('短文テンプレ：希少モードでは絵文字装飾を使わない', () => {
  const { title } = buildStockMonitorCtr({
    variant: 'A',
    stockHint: 'scarce',
    itemTitle: 'スニーカー',
    shoeRaw: '26.5',
    price: 12000,
    listPrice: 15000,
  });
  assert.match(title, /残りわずか|急げ|\|/);
  assert.ok(!/🔥|⚡|💎|💰/.test(title));
});

test('templateId が st_{variant}_{mode}', () => {
  const r = buildStockMonitorCtr({
    variant: 'B',
    stockHint: 'ok',
    itemTitle: 'X',
    shoeRaw: '26.5',
    price: 10000,
    listPrice: 10000,
  });
  assert.match(r.templateId, /^st_B_/);
});

test('入荷短文：サイズ＋縦線＋行動', () => {
  const { title } = buildStockMonitorCtr({
    variant: 'A',
    stockHint: 'ok',
    itemTitle: 'Test',
    shoeRaw: '27',
    price: 12000,
    listPrice: 12000,
  });
  assert.match(title, /\d|入荷|\|/);
  assert.ok(title.length <= 52);
});

test('cheap でもタイトルに価格単体は載せない', () => {
  const { title } = buildStockMonitorCtr({
    variant: 'C',
    stockHint: 'ok',
    itemTitle: 'Item',
    shoeRaw: '27',
    price: 5000,
    listPrice: 12000,
  });
  assert.ok(!/^¥/.test(title));
});
