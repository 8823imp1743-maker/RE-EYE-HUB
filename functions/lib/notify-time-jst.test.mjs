import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getJstHour, getTimeScoreHourJst, getTimeScoreJst } from './notify-time-jst.js';

test('JST 19時台は timeScore 1.5', () => {
  const d = new Date('2026-04-30T10:00:00.000Z');
  assert.equal(getJstHour(d.getTime()), 19);
  assert.equal(getTimeScoreHourJst(19), 1.5);
  assert.equal(getTimeScoreJst(d.getTime()), 1.5);
});

test('JST 深夜は timeScore 0.7', () => {
  assert.equal(getTimeScoreHourJst(3), 0.7);
});
