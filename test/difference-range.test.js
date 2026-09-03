import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoInstant, ChronoPlain, ChronoZoned } from '../lib/index.js';

const MAX = 8.64e15;

describe('long class differences retain the full Number range', () => {
  test('instant, plain, and zoned differences do not narrow to int32', () => {
    const instantLo = ChronoInstant.fromEpochMs(-MAX);
    const instantHi = ChronoInstant.fromEpochMs(MAX);
    assert.equal(instantLo.secondsUntil(instantHi), 17_280_000_000_000);
    assert.equal(instantLo.minutesUntil(instantHi), 288_000_000_000);
    assert.equal(instantLo.hoursUntil(instantHi), 4_800_000_000);
    assert.equal(instantLo.daysUntil(instantHi), 200_000_000);
    assert.equal(instantHi.hoursUntil(instantLo), -4_800_000_000);

    const plainLo = ChronoPlain.parse('-271821-04-20T00:00:00');
    const plainHi = ChronoPlain.parse('+275760-09-13T00:00:00');
    assert.equal(plainLo.minutesUntil(plainHi), 288_000_000_000);
    assert.equal(plainLo.hoursUntil(plainHi), 4_800_000_000);

    const zonedLo = ChronoZoned.fromEpochMs(-MAX, 'UTC');
    const zonedHi = ChronoZoned.fromEpochMs(MAX, 'UTC');
    assert.equal(zonedLo.minutesUntil(zonedHi), 288_000_000_000);
    assert.equal(zonedLo.hoursUntil(zonedHi), 4_800_000_000);
  });

  test('truncation toward zero does not expose negative zero', () => {
    const result = ChronoInstant.fromEpochMs(500).secondsUntil(ChronoInstant.fromEpochMs(0));
    assert.equal(result, 0);
    assert.equal(Object.is(result, -0), false);
  });
});
