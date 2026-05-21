import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCeFeedbackPromptNudgeFromData, ceFeedbackUrlHost } from './ce-feedback.js';

describe('ceFeedbackUrlHost', () => {
  it('有効 URL から hostname', () => {
    assert.equal(ceFeedbackUrlHost('https://shopping.yahoo.co.jp/foo/bar'), 'shopping.yahoo.co.jp');
  });
  it('不正は空', () => {
    assert.equal(ceFeedbackUrlHost(''), '');
  });
});

describe('buildCeFeedbackPromptNudgeFromData', () => {
  it('空データは空文字', () => {
    assert.equal(buildCeFeedbackPromptNudgeFromData({}, []), '');
  });
  it('フラグ累積と直近を含む', () => {
    const s = buildCeFeedbackPromptNudgeFromData(
      { gender_conflict: '3', SERP汚染検出: '1' },
      [JSON.stringify({ flags: ['gender_conflict'], host: 'a.example.com' })],
    );
    assert.ok(s.includes('gender_conflict'));
    assert.ok(s.includes('3回'));
    assert.ok(s.includes('過去に PDP'));
  });
});
