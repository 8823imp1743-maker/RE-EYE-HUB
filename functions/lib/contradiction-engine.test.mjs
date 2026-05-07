import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateContradictionEngine, computeGenderMatch } from './contradiction-engine.js';

describe('computeGenderMatch', () => {
  it('ユーザー未設定は常に一致扱い', () => {
    assert.equal(computeGenderMatch('unknown', 'female'), true);
  });
  it('ユニセックス商品は一致', () => {
    assert.equal(computeGenderMatch('male', 'unisex'), true);
  });
  it('男女逆は不一致', () => {
    assert.equal(computeGenderMatch('male', 'female'), false);
  });
});

describe('evaluateContradictionEngine', () => {
  it('PDP on ・性別矛盾・高 confidence → reject', () => {
    const r = evaluateContradictionEngine({
      llmCategory: 'shoe',
      llmConfidence: 0.9,
      serpStrongMatch: false,
      pdpResult: 'on',
      userGender: 'male',
      productGender: 'female',
      productRole: 'main',
    });
    assert.equal(r.status, 'reject');
    assert.ok(r.flags.includes('gender_conflict'));
  });

  it('PDP on ・性別一致 → accept', () => {
    const r = evaluateContradictionEngine({
      llmCategory: 'shoe',
      llmConfidence: 0.9,
      serpStrongMatch: false,
      pdpResult: 'on',
      userGender: 'male',
      productGender: 'male',
      productRole: 'main',
    });
    assert.equal(r.status, 'accept');
  });

  it('PDP off ・LLM高信頼・靴 → reject（複合フラグ）', () => {
    const r = evaluateContradictionEngine({
      llmCategory: 'shoe',
      llmConfidence: 0.9,
      serpStrongMatch: false,
      pdpResult: 'off',
      userGender: 'unknown',
      productGender: 'unisex',
      productRole: 'main',
    });
    assert.equal(r.status, 'reject');
    assert.ok(r.flags.includes('LLM過信エラー'));
    assert.ok(r.flags.includes('構造矛盾'));
  });

  it('PDP off ・fetch retryable → retry', () => {
    const r = evaluateContradictionEngine({
      llmCategory: 'shoe',
      llmConfidence: 0.5,
      serpStrongMatch: false,
      pdpResult: 'off',
      pdpRetryable: true,
      pdpReason: 'fetch_fail_strict',
      userGender: 'unknown',
      productGender: 'unisex',
      productRole: 'main',
    });
    assert.equal(r.status, 'retry');
  });

  it('PDP on ・accessory 高 confidence → reject', () => {
    const r = evaluateContradictionEngine({
      llmCategory: 'shoe',
      llmConfidence: 0.9,
      serpStrongMatch: false,
      pdpResult: 'on',
      userGender: 'unknown',
      productGender: 'unisex',
      productRole: 'accessory',
    });
    assert.equal(r.status, 'reject');
    assert.ok(r.flags.includes('accessory_pdp_true'));
  });

  it('PDP on ・accessory 低 confidence でも reject（LOCK: accessory×PDP真）', () => {
    const r = evaluateContradictionEngine({
      llmCategory: 'shoe',
      llmConfidence: 0.5,
      serpStrongMatch: false,
      pdpResult: 'on',
      userGender: 'unknown',
      productGender: 'unisex',
      productRole: 'accessory',
    });
    assert.equal(r.status, 'reject');
    assert.ok(r.flags.includes('accessory_pdp_true'));
  });

  it('PDP on ・packaging 低 confidence でも reject（LOCK: packaging×PDP真）', () => {
    const r = evaluateContradictionEngine({
      llmCategory: 'sticker',
      llmConfidence: 0.4,
      serpStrongMatch: false,
      pdpResult: 'on',
      userGender: 'unknown',
      productGender: 'unisex',
      productRole: 'packaging',
    });
    assert.equal(r.status, 'reject');
    assert.ok(r.flags.includes('packaging_pdp_true'));
  });
});
