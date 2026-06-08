import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeNoise,
  titleIsUsedMarket,
  isShoeApparelPollution,
  filterShoeMallPollution,
} from './noise-filter.js';

describe('titleIsUsedMarket', () => {
  it('rejects 【中古】 in title', () => {
    assert.equal(titleIsUsedMarket('【中古】ナイキ エアマックス 90'), true);
  });
  it('rejects plain 中古', () => {
    assert.equal(titleIsUsedMarket('中古 NIKE AIR MAX'), true);
  });
  it('allows new items', () => {
    assert.equal(titleIsUsedMarket('ナイキ エアマックス 90 新品'), false);
  });
});

describe('analyzeNoise used hard reject', () => {
  it('marks used sneakers as noise', () => {
    const r = analyzeNoise({ title: '【中古】ナイキ スニーカー 26.5cm' });
    assert.equal(r.isNoise, true);
    assert.ok(r.reasons.includes('WORD:中古'));
  });
});

describe('isShoeApparelPollution', () => {
  it('rejects T-shirt with Air Max co-brand', () => {
    const t =
      'ナイキ NIKE ジュニア カジュアルウエア トップス 半袖 Tシャツ YTH NSW エア マックス 90 S/S';
    assert.equal(isShoeApparelPollution({ title: t, sourceId: 'yahoo' }), true);
  });
  it('keeps explicit sneakers', () => {
    assert.equal(
      isShoeApparelPollution({ title: 'ナイキ エアマックス 90 スニーカー メンズ 26.5cm' }),
      false
    );
  });
  it('rejects non-shoe Yahoo genre', () => {
    assert.equal(
      isShoeApparelPollution({
        title: 'ナイキ エアマックス 90',
        sourceId: 'yahoo',
        genreCategoryId: '2080349094',
      }),
      true
    );
  });
});

describe('filterShoeMallPollution', () => {
  it('filters apparel only', () => {
    const items = [
      { title: 'ナイキ Tシャツ エアマックス 90' },
      { title: 'ナイキ エアマックス 90 スニーカー' },
    ];
    const out = filterShoeMallPollution(items);
    assert.equal(out.length, 1);
    assert.match(out[0].title, /スニーカー/);
  });
});
