import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPaidPlan,
  coercePlanTier,
  digestPathForPlan,
  shouldApplyTagAndFilter,
  stablePercentBucket,
} from './notify-plan-policy.js';

test('coercePlanTier と isPaidPlan', () => {
  assert.equal(coercePlanTier('vip'), 'VIP');
  assert.equal(coercePlanTier('junk'), 'FREE');
  assert.equal(isPaidPlan('PRO'), true);
  assert.equal(isPaidPlan('FREE'), false);
});

test('digestPathForPlan: Digest 無効は即時のみ', () => {
  assert.equal(
    digestPathForPlan('FREE', { RE_EYE_DIGEST_ENABLE: '0' }),
    'instant',
  );
});

test('digestPathForPlan: paid_fast は有料のみ即時', () => {
  const env = { RE_EYE_DIGEST_ENABLE: '1', RE_EYE_DIGEST_SCOPE: 'paid_fast' };
  assert.equal(digestPathForPlan('FREE', env), 'digest');
  assert.equal(digestPathForPlan('PRO', env), 'instant');
});

test('TAG フィルタ段階導入: 0 と 100', () => {
  assert.equal(
    shouldApplyTagAndFilter('u-test', {
      RE_EYE_TAG_FILTER_ROLLOUT_PCT: '0',
    }),
    false,
  );
  assert.equal(
    shouldApplyTagAndFilter('u-test', {
      RE_EYE_TAG_FILTER_ROLLOUT_PCT: '100',
    }),
    true,
  );
});

test('stablePercentBucket はユーザー固定', () => {
  const x = stablePercentBucket('same-id');
  assert.equal(stablePercentBucket('same-id'), x);
});
