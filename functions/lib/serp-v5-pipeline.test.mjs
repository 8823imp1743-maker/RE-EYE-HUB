/**
 * v5.0 共有パイプライン（PDP arm 解決・軽量ノイズ）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  titleMatchesLocalNoiseV5,
  resolveSerpV5PdpTask,
  kwPdpSizeEligible,
} from './serp-v5-pipeline.js';

describe('titleMatchesLocalNoiseV5', () => {
  it('タイトルに互換が含まれると true', () => {
    assert.equal(titleMatchesLocalNoiseV5({ title: '互換 ケース' }), true);
  });
  it('該当なしは false', () => {
    assert.equal(titleMatchesLocalNoiseV5({ title: '正規品 スニーカー' }), false);
  });
});

describe('kwPdpSizeEligible', () => {
  it('靴 cm は true', () => {
    assert.equal(kwPdpSizeEligible({ type: 'shoe', raw: '26.5' }), true);
  });
  it('服 XL は true', () => {
    assert.equal(kwPdpSizeEligible({ type: 'clothing', raw: 'XL' }), true);
  });
  it('服 XS は false', () => {
    assert.equal(kwPdpSizeEligible({ type: 'clothing', raw: 'XS' }), false);
  });
});

describe('resolveSerpV5PdpTask', () => {
  const item = { title: 'x', url: 'https://example.com/p' };

  it('① 靴: kw shoe + category shoe → shoe', () => {
    const t = resolveSerpV5PdpTask(
      { category: 'shoe', product_role: 'main', gender: 'unisex', confidence: 0.7 },
      item,
      { keyword: 'test', colorKeywords: [], modelNumbers: [] },
      { type: 'shoe', raw: '26.5' },
    );
    assert.deepEqual(t, { kind: 'shoe', raw: '26.5' });
  });

  it('① 服: kw clothing + category clothing → clothing', () => {
    const t = resolveSerpV5PdpTask(
      { category: 'clothing', product_role: 'main', gender: 'unisex', confidence: 0.7 },
      item,
      { keyword: 'パーカー M', colorKeywords: [], modelNumbers: [] },
      { type: 'clothing', raw: 'M' },
    );
    assert.deepEqual(t, { kind: 'clothing', raw: 'M' });
  });

  it('③ main + confidence≥0.85 → generic（kw 無しでも）', () => {
    const t = resolveSerpV5PdpTask(
      { category: 'sticker', product_role: 'main', gender: 'unisex', confidence: 0.9 },
      item,
      { keyword: 'test', colorKeywords: [], modelNumbers: [] },
      null,
    );
    assert.deepEqual(t, { kind: 'generic' });
  });

  it('② entry 無し・低スコア要素 → null', () => {
    const t = resolveSerpV5PdpTask(
      { category: 'sticker', product_role: 'accessory', gender: 'unisex', confidence: 0.5 },
      item,
      null,
      null,
    );
    assert.equal(t, null);
  });
});
