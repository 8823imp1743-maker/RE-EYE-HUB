import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLtqScore, shouldSkipLtqFree } from './notify-ltv.js';

test('computeLtqScore がホットワードで上がる', () => {
  const s = computeLtqScore({
    title: 'リストック限定',
    price: 10000,
    listPrice: 10000,
    available: true,
  });
  assert.ok(s >= 3);
});

test('shouldSkipLtqFree: FREE は低スコアでスキップ', () => {
  assert.equal(
    shouldSkipLtqFree({
      plan: 'FREE',
      score: 0,
      minScore: 3,
    }),
    true,
  );
  assert.equal(
    shouldSkipLtqFree({
      plan: 'FREE',
      score: 5,
      minScore: 3,
    }),
    false,
  );
});

test('shouldSkipLtqFree: 有課金は既定で落とさない', () => {
  assert.equal(
    shouldSkipLtqFree({
      plan: 'PRO',
      score: 0,
      minScore: 3,
      skipPaidLtq: false,
    }),
    false,
  );
});

test('minScore が 0 以下は効かない', () => {
  assert.equal(
    shouldSkipLtqFree({
      plan: 'FREE',
      score: 0,
      minScore: 0,
    }),
    false,
  );
});
