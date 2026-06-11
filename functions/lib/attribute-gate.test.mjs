import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAttributeGate,
  buildTargetAttributesFromEntry,
  listingSupportsTargetCm,
} from './attribute-gate.js';

describe('listingSupportsTargetCm', () => {
  it('レンジ内の希望 cm を許可', () => {
    assert.equal(listingSupportsTargetCm('WMNS 22cm-25cm ホワイト', ['23.5']), true);
  });
  it('レンジ外は拒否', () => {
    assert.equal(listingSupportsTargetCm('WMNS 22cm-25cm', ['26.5']), false);
  });
});

describe('buildTargetAttributesFromEntry', () => {
  it('キーワードから model/color/size を抽出', () => {
    const ta = buildTargetAttributesFromEntry({
      keyword: 'ナイキ エアマックス90 ホワイト CW2288-111 27cm',
      modelNumbers: ['CW2288-111'],
      colorKeywords: ['ホワイト'],
    });
    assert.equal(ta.model, 'CW2288-111');
    assert.equal(ta.color, 'ホワイト');
    assert.equal(ta.size, '27');
    assert.equal(ta.sizeType, 'shoe');
  });
  it('服サイズ XL を受理', () => {
    const ta = buildTargetAttributesFromEntry({
      keyword: 'パーカー ブラック XL CW2288-111',
      modelNumbers: ['CW2288-111'],
      colorKeywords: ['ブラック'],
    }, { size: 'XL' });
    assert.equal(ta.size, 'XL');
    assert.equal(ta.sizeType, 'clothing');
  });
});

describe('evaluateAttributeGate', () => {
  const entry = {
    keyword: 'CW2288-111 ホワイト 26.5cm',
    modelNumbers: ['CW2288-111'],
    colorKeywords: ['ホワイト'],
  };

  it('3軸一致で pass', () => {
    const r = evaluateAttributeGate(entry, {
      title: 'Nike Air Max CW2288-111 ホワイト 26.5cm',
      colorLabel: 'ホワイト',
    });
    assert.equal(r.pass, true);
    assert.equal(r.reason, 'attribute_gate_pass');
  });

  it('型番不一致で skip', () => {
    const r = evaluateAttributeGate(entry, {
      title: 'Nike Air Max IM3110-500 ホワイト 26.5cm',
    });
    assert.equal(r.pass, false);
    assert.equal(r.reason, 'attribute_gate_skip');
    assert.equal(r.failedAxis, 'model');
  });

  it('色不一致で skip', () => {
    const r = evaluateAttributeGate(entry, {
      title: 'Nike CW2288-111 ブラック 26.5cm',
    });
    assert.equal(r.pass, false);
    assert.equal(r.failedAxis, 'color');
  });

  it('サイズ不一致で skip', () => {
    const r = evaluateAttributeGate(entry, {
      title: 'Nike CW2288-111 ホワイト 27cm',
    });
    assert.equal(r.pass, false);
    assert.equal(r.failedAxis, 'size');
  });

  it('品番未指定は skip', () => {
    const r = evaluateAttributeGate(
      { keyword: 'ホワイト 26.5cm', modelNumbers: [], colorKeywords: ['ホワイト'] },
      { title: 'Nike ホワイト 26.5cm' }
    );
    assert.equal(r.failedAxis, 'model');
  });
});
