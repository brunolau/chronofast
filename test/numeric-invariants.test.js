import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChronoDate, ChronoInstant, ChronoPlain, ChronoZoned, InvalidInstantError,
} from '../lib/index.js';
import { parseISO, parseISOWall, parseISOZonedWall, toISO } from '../lib/core.js';
import { offsetAt } from '../lib/zone.js';

const MAX = 8.64e15;

describe('parsing fails closed outside the ECMAScript time range', () => {
  test('the inclusive boundaries remain valid', () => {
    assert.equal(parseISO('+275760-09-13T00:00:00.000Z'), MAX);
    assert.equal(parseISO('-271821-04-20T00:00:00.000Z'), -MAX);
  });

  test('one millisecond past either boundary and remote expanded years fail', () => {
    const bad = [
      '+275760-09-13T00:00:00.001Z',
      '-271821-04-19T23:59:59.999Z',
      '+999999-12-31T23:59:59.999Z',
      '-999999-01-01T00:00:00.000Z',
    ];
    for (const input of bad) {
      assert.ok(Number.isNaN(parseISO(input)), input);
      for (const Type of [ChronoInstant, ChronoPlain]) {
        assert.throws(() => Type.parse(input), InvalidInstantError, input);
        assert.equal(Type.tryParse(input), null, input);
      }
      assert.throws(() => ChronoZoned.parse(input, 'UTC'), InvalidInstantError, input);
      assert.equal(ChronoZoned.tryParse(input, 'UTC'), null, input);
    }
  });

  test('the offset is applied before validating an instant', () => {
    const input = '+275760-09-13T01:00:00+01:00';
    assert.equal(parseISO(input), MAX);
    assert.equal(ChronoInstant.parse(input).epochMilliseconds, MAX);
    assert.throws(() => ChronoPlain.parse(input), InvalidInstantError,
      'the local reading itself lies past the wall-clock range');
  });

  test('wall parsing discards an offset even when the corresponding instant is out of range', () => {
    const cases = [
      ['-271821-04-20T00:00:00+01:00', -MAX, '-271821-04-20T00:00:00'],
      ['+275760-09-13T00:00:00-01:00', MAX, '+275760-09-13T00:00:00'],
    ];
    for (const [input, wall, output] of cases) {
      assert.ok(Number.isNaN(parseISO(input)), input);
      assert.equal(parseISOWall(input), wall, input);
      assert.equal(ChronoPlain.parse(input).toPlainISOString(), output, input);
      assert.throws(() => ChronoZoned.parse(input, 'UTC'), InvalidInstantError, input);
    }
  });

  test('zoned wall parsing has the open one-day padding required for boundary offsets', () => {
    const DAY = 86_400_000;
    assert.equal(parseISOZonedWall('-271821-04-19T00:00:00.001'), -MAX - DAY + 1);
    assert.equal(parseISOZonedWall('+275760-09-13T23:59:59.999'), MAX + DAY - 1);
    assert.ok(Number.isNaN(parseISOZonedWall('-271821-04-19T00:00:00.000')));
    assert.ok(Number.isNaN(parseISOZonedWall('+275760-09-14T00:00:00.000')));
    assert.throws(() => ChronoPlain.parse('-271821-04-19T00:00:00.001'), InvalidInstantError);
    assert.throws(() => ChronoPlain.parse('+275760-09-13T23:59:59.999'), InvalidInstantError);
  });

  test('padded zoned readings resolve to boundary instants without widening ChronoPlain', () => {
    const cases = [
      ['+275760-09-13T12:00', 'Etc/GMT-12', [275760, 9, 13, 12], MAX],
      ['-271821-04-19T12:00', 'Etc/GMT+12', [-271821, 4, 19, 12], -MAX],
    ];
    for (const [input, zone, fields, instant] of cases) {
      assert.equal(ChronoZoned.parse(input, zone).epochMilliseconds, instant, input);
      assert.equal(ChronoZoned.tryParse(input, zone)?.epochMilliseconds, instant, input);
      assert.equal(ChronoZoned.fromLocal(zone, ...fields).epochMilliseconds, instant, input);
      assert.throws(() => ChronoZoned.parse(input, 'UTC'), InvalidInstantError, input);
      assert.equal(ChronoZoned.tryParse(input, 'UTC'), null, input);
      assert.throws(() => ChronoZoned.fromLocal('UTC', ...fields), InvalidInstantError, input);
      assert.throws(() => ChronoPlain.parse(input), InvalidInstantError, input);
    }
  });

  test('same-local zone changes can resolve a padded endpoint wall clock', () => {
    const HOUR = 3_600_000;
    const maximum = ChronoZoned.fromEpochMs(MAX, 'Etc/GMT-12');
    assert.equal(maximum.withZoneSameLocal('Etc/GMT-12', 'later').epochMilliseconds, MAX);
    assert.equal(maximum.withZoneSameLocal('Etc/GMT-14').epochMilliseconds, MAX - 2 * HOUR);
    assert.throws(() => maximum.withZoneSameLocal('UTC'), InvalidInstantError);

    const minimum = ChronoZoned.fromEpochMs(-MAX, 'Etc/GMT+10');
    assert.equal(minimum.withZoneSameLocal('Etc/GMT+12').epochMilliseconds, -MAX + 2 * HOUR);
    assert.throws(() => minimum.withZoneSameLocal('UTC'), InvalidInstantError);
  });

  test('endpoint probe clamps do not make out-of-range instants valid', () => {
    assert.equal(offsetAt('UTC', MAX), 0);
    assert.equal(offsetAt('UTC', -MAX), 0);
    assert.throws(() => offsetAt('UTC', MAX + 1), RangeError);
    assert.throws(() => offsetAt('UTC', -MAX - 1), RangeError);
  });

  test('date parsing validates the written date, not a discarded time or offset', () => {
    const cases = [
      ['-271821-04-19T23:59:59.999', '-271821-04-19'],
      ['-271821-04-20T00:00:00+01:00', '-271821-04-20'],
      ['+275760-09-13T00:00:00.001', '+275760-09-13'],
      ['+275760-09-13T23:59:59.999-23:59', '+275760-09-13'],
    ];
    for (const [input, output] of cases) {
      assert.equal(ChronoDate.parse(input).toISODate(), output, input);
      assert.equal(ChronoDate.tryParse(input)?.toISODate(), output, input);
    }
  });
});

describe('millisecond precision is integral and arithmetic fails before returning invalid', () => {
  test('fractional epoch milliseconds are rejected consistently', () => {
    for (const ms of [0.1, 0.5, -1.5]) {
      assert.throws(() => ChronoInstant.fromEpochMs(ms), InvalidInstantError);
      assert.throws(() => ChronoZoned.fromEpochMs(ms, 'UTC'), InvalidInstantError);
      assert.throws(() => toISO(ms), RangeError);
      for (const value of [new ChronoInstant(ms), new ChronoPlain(ms),
                           new ChronoDate(ms), new ChronoZoned(ms, 'UTC')]) {
        assert.equal(value.isValid, false);
        assert.equal(value.toString(), 'Invalid Date');
        assert.equal(value.toJSON(), null);
        assert.equal(value.toLocaleString('en-US'), 'Invalid Date');
      }
    }
  });

  test('all duration arguments are finite integers, matching Temporal duration fields', () => {
    const cases = [
      [ChronoInstant.fromEpochMs(0),
        ['addMilliseconds', 'addSeconds', 'addMinutes', 'addHours', 'addDays']],
      [ChronoPlain.of(2024, 1, 1),
        ['addMilliseconds', 'addSeconds', 'addMinutes', 'addHours', 'addDays',
         'addWeeks', 'addMonths', 'addYears']],
      [ChronoDate.of(2024, 1, 1), ['addDays', 'addWeeks', 'addMonths', 'addYears']],
      [ChronoZoned.fromEpochMs(0, 'UTC'),
        ['addSeconds', 'addMinutes', 'addHours', 'addDays', 'addMonths', 'addYears']],
    ];
    for (const [value, methods] of cases) {
      for (const method of methods) {
        for (const amount of [0.5, NaN, Infinity, -Infinity]) {
          assert.throws(() => value[method](amount), RangeError,
            `${value.constructor.name}.${method}(${amount})`);
        }
      }
    }
  });

  test('overflowing arithmetic throws rather than returning an invalid instance', () => {
    assert.throws(() => ChronoInstant.fromEpochMs(MAX).addMilliseconds(1), InvalidInstantError);
    assert.throws(() => ChronoInstant.fromEpochMs(-MAX).addMilliseconds(-1), InvalidInstantError);
    assert.throws(() => ChronoZoned.fromEpochMs(MAX, 'UTC').addSeconds(1), InvalidInstantError);
    assert.throws(() => ChronoPlain.parse('+275760-09-13T00:00').addMilliseconds(1), RangeError);
    assert.throws(() => ChronoDate.of(275760, 9, 13).addDays(1), RangeError);
    assert.throws(() => ChronoPlain.of(2024, 1, 1).addYears(Number.MAX_VALUE), RangeError);
    assert.throws(() => ChronoDate.of(2024, 1, 1).addYears(Number.MAX_VALUE), RangeError);

    const minimumPlain = ChronoPlain.parse('-271821-04-20T00:00');
    assert.throws(() => minimumPlain.startOfMonth(), RangeError);
    assert.throws(() => ChronoDate.of(-271821, 4, 20).startOfMonth(), RangeError);
    assert.throws(() => ChronoDate.of(275760, 9, 13).endOfMonth(), RangeError);
  });

  test('the invalid sentinel still propagates through arithmetic', () => {
    const cases = [
      new ChronoInstant(Number.NaN).addMilliseconds(1),
      new ChronoPlain(Number.NaN).addMilliseconds(1),
      new ChronoDate(Number.NaN).addDays(1),
      new ChronoZoned(Number.NaN, 'UTC').addSeconds(1),
      new ChronoZoned(Number.NaN, 'UTC').addDays(1),
      new ChronoZoned(Number.NaN, 'UTC').addMonths(1),
      new ChronoZoned(Number.NaN, 'UTC').addYears(1),
      new ChronoZoned(Number.NaN, 'UTC').startOfDay(),
    ];
    for (const value of cases) {
      assert.equal(value.isValid, false, value.constructor.name);
      assert.equal(value.toString(), 'Invalid Date', value.constructor.name);
    }
  });

  test('lossy conversions cannot launder a fractional receiver', () => {
    const invalid = [
      new ChronoDate(0.5).toPlain(),
      new ChronoDate(0.5).atStartOfDay('UTC'),
      new ChronoPlain(0.5).toPlainDate(),
      new ChronoZoned(0.5, 'UTC').toPlainDate(),
    ];
    for (const value of invalid) {
      assert.equal(value.isValid, false, value.constructor.name);
      assert.equal(value.toString(), 'Invalid Date', value.constructor.name);
    }
    assert.ok(Number.isNaN(new ChronoInstant(0.5).toDate().getTime()));
    assert.ok(Number.isNaN(new ChronoZoned(0.5, 'UTC').toDate().getTime()));
  });
});

describe('calendar factories reject impossible fields instead of balancing them', () => {
  test('ChronoPlain.of validates every date and time component', () => {
    const bad = [
      [2023, 2, 29], [2024, 2, 30], [2024, 0, 1], [2024, 13, 1],
      [2024, 1.5, 1], [2024, 1, 0], [2024, 1, 1.5],
      [2024, 1, 1, -1], [2024, 1, 1, 24], [2024, 1, 1, 0, 60],
      [2024, 1, 1, 0, 0, 60], [2024, 1, 1, 0, 0, 0, 1000],
      [2024, 1, 1, 0, 0, 0, 0.5], [Infinity, 1, 1],
    ];
    for (const fields of bad) {
      assert.throws(() => ChronoPlain.of(...fields), RangeError, fields.join(','));
    }
    assert.equal(ChronoPlain.of(2024, 2, 29, 23, 59, 59, 999).toPlainISOString(),
      '2024-02-29T23:59:59.999');
  });

  test('ChronoDate.of, date-to-time, and ChronoZoned.fromLocal validate too', () => {
    for (const fields of [[2023, 2, 29], [2024, 4, 31], [2024, 0, 1], [2024, 1, 1.5]]) {
      assert.throws(() => ChronoDate.of(...fields), RangeError, fields.join(','));
    }
    const date = ChronoDate.of(2024, 2, 29);
    assert.throws(() => date.toPlain(24), RangeError);
    assert.throws(() => date.atTime(12, 60), RangeError);
    assert.throws(() => date.atTime(12, 30, 0, 0.5), RangeError);
    assert.throws(() => date.startOfWeek(0), RangeError);
    assert.throws(() => date.startOfWeek(1.5), RangeError);
    assert.throws(() => ChronoPlain.of(2024, 1, 1).startOfWeek(7), RangeError);
    assert.throws(() => ChronoPlain.of(2024, 1, 1).startOfWeek(0.5), RangeError);
    assert.throws(() => ChronoZoned.fromLocal('UTC', 2023, 2, 29), RangeError);
    assert.throws(() => ChronoZoned.fromLocal('UTC', 2024, 1, 1, 24), RangeError);
    assert.equal(ChronoZoned.fromLocal('UTC', 2024, 2, 29, 23, 59, 59, 999).toISOString(),
      '2024-02-29T23:59:59.999+00:00');
  });

  test('ChronoDate uses the complete Temporal.PlainDate range', () => {
    const min = ChronoDate.of(-271821, 4, 19);
    const max = ChronoDate.of(275760, 9, 13);
    assert.equal(min.toISODate(), '-271821-04-19');
    assert.equal(max.toISODate(), '+275760-09-13');
    assert.equal(min.addDays(1).toISODate(), '-271821-04-20');
    assert.equal(ChronoDate.of(-271821, 5, 19).addMonths(-1).toISODate(), '-271821-04-19');
    assert.equal(ChronoDate.of(-271820, 4, 19).addYears(-1).toISODate(), '-271821-04-19');
    assert.throws(() => min.addDays(-1), RangeError);
    assert.throws(() => max.addDays(1), RangeError);
    assert.throws(() => ChronoDate.of(-271821, 4, 18), RangeError);
    assert.throws(() => ChronoDate.of(275760, 9, 14), RangeError);
    assert.equal(
      ChronoZoned.fromEpochMs(-MAX, 'America/New_York').toPlainDate().toISODate(),
      '-271821-04-19',
    );
    assert.throws(() => min.toPlain(), RangeError,
      'the wider date range cannot always become a representable wall clock');
    assert.throws(() => min.toLocaleString('en-US'), RangeError);
  });
});
