import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFunnelId, buildFunnelPayloadFromEntry } from './purchase-funnel.js';

describe('buildFunnelId', () => {
  it('16文字 hex を返す', () => {
    const id = buildFunnelId({
      userId: 'u1',
      model: 'CW2288-111',
      color: 'ホワイト',
      size: '27',
      opsSource: 'monitor_serp',
      notifyAt: 1,
    });
    assert.equal(id.length, 16);
    assert.match(id, /^[a-f0-9]{16}$/);
  });

  it('同一入力は同一 id', () => {
    const a = buildFunnelId({ userId: 'u', notifyAt: 99, opsSource: 'poll' });
    const b = buildFunnelId({ userId: 'u', notifyAt: 99, opsSource: 'poll' });
    assert.equal(a, b);
  });
});

describe('buildFunnelPayloadFromEntry', () => {
  it('targetAttributes から funnel フィールドを組み立てる', () => {
    const p = buildFunnelPayloadFromEntry(
      {
        targetAttributes: { model: 'CW2288-111', color: 'ホワイト', size: '27' },
        modelNumbers: ['CW2288-111'],
        colorKeywords: ['ホワイト'],
      },
      'user-abc',
      'monitor_serp'
    );
    assert.ok(p.funnelId);
    assert.equal(p.funnelModel, 'CW2288-111');
    assert.equal(p.funnelColor, 'ホワイト');
    assert.equal(p.funnelSize, '27');
    assert.equal(p.funnelOpsSource, 'monitor_serp');
  });
});
