/**
 * vNEXT スコア・性別補正の回帰
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { genderScoreAdjustment, scoreSerpClassification, browseCacheKey } from './serp-product-classifier.js';

describe('genderScoreAdjustment (vNEXT §6)', () => {
  it('一致 +0.4', () => {
    assert.equal(genderScoreAdjustment('male', 'male'), 0.4);
    assert.equal(genderScoreAdjustment('female', 'female'), 0.4);
  });
  it('male×female / female×male は -0.8', () => {
    assert.equal(genderScoreAdjustment('male', 'female'), -0.8);
    assert.equal(genderScoreAdjustment('female', 'male'), -0.8);
  });
});

describe('scoreSerpClassification', () => {
  it('v3.1: confidence は 0〜1 をそのまま加点（main +0.4 と合わせて 1.39）', () => {
    const row = { product_role: 'main', gender: 'unisex', confidence: 0.99 };
    const s = scoreSerpClassification(row, 'unknown', 'xyz');
    assert.equal(s, 1.39);
  });

  it('v3.1: fake は -1.0', () => {
    const row = { product_role: 'fake', gender: 'unisex', confidence: 0 };
    const s = scoreSerpClassification(row, 'unknown', 'clean');
    assert.equal(s, -1);
  });
});

describe('browseCacheKey', () => {
  it('keyword と gender でキーが変わる', () => {
    const a = browseCacheKey('u_test123', 'nike', 'male');
    const b = browseCacheKey('u_test123', 'nike', 'female');
    assert.notEqual(a, b);
  });
});
