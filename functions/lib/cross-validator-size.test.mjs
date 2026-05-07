/**
 * キーワード抽出・服アルファ境界（fail-close）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractSizeFromKeyword } from './cross-validator.js';

describe('extractSizeFromKeyword', () => {
  it('26.5cm → shoe 26.5', () => {
    const r = extractSizeFromKeyword('nike 26.5cm');
    assert.ok(r);
    assert.equal(r.type, 'shoe');
    assert.equal(r.raw, '26.5');
  });

  it('約26.5cm → null', () => {
    assert.equal(extractSizeFromKeyword('スニーカー 約26.5cm'), null);
  });

  it('26-27cm レンジ → null', () => {
    assert.equal(extractSizeFromKeyword('靴 26-27cm'), null);
  });

  it('US8 のみ（cm 無し）→ null', () => {
    assert.equal(extractSizeFromKeyword('nike US8'), null);
  });

  it('M 服 → clothing', () => {
    const r = extractSizeFromKeyword('パーカー M 新品');
    assert.ok(r);
    assert.equal(r.type, 'clothing');
    assert.equal(r.raw, 'M');
  });

  it('XXL → null（PDP 対象外）', () => {
    assert.equal(extractSizeFromKeyword('コート XXL'), null);
  });

  it('XS → null（PDP 対象外）', () => {
    assert.equal(extractSizeFromKeyword('パーカー XS'), null);
  });

  it('フリーサイズ → null', () => {
    assert.equal(extractSizeFromKeyword('シャツ M フリーサイズ'), null);
  });

  it('XL は XL（XXL と誤検出しない）', () => {
    const r = extractSizeFromKeyword('コート XL');
    assert.ok(r);
    assert.equal(r.raw, 'XL');
  });
});
