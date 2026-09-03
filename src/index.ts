// chronofast - public surface.
//
// Three types, and the discipline is that **each one is missing what the others have**.
// That is not stylistic: an earlier version of this library had a single class carrying
// both calendar fields and epoch milliseconds, and it could silently impersonate either
// role. Sorting a mixed array misordered it, and `.inZone()` on a wall-clock value applied
// the offset twice. Neither mistake was catchable by the compiler.
//
//   ChronoInstant   a moment. Has epochMilliseconds. Has NO calendar fields.
//   ChronoPlain     a clock reading. Has calendar fields. Has NO epochMilliseconds.
//   ChronoZoned     both, legitimately - a zone is exactly what turns one into the other.
//
// This mirrors how Temporal separates Instant / PlainDateTime / ZonedDateTime, and for the
// same reason: capabilities are removed rather than merely documented.

export type { EpochMs, WallMs, TimeZoneId, DayIndex } from './brand.js';
export { InvalidInstantError, UnknownTimeZoneError } from './brand.js';
export type { DateTimeFields } from './core.js';
export type { Disambiguation } from './zone.js';
export { AmbiguousTimeError } from './zone.js';

import type { EpochMs, WallMs, TimeZoneId, DayIndex } from './brand.js';
import {
  unsafeEpochMs, unsafeWallMs, unsafeDayIndex, epochMs as checkedEpochMs,
  timeZone as checkedZone,
  InvalidInstantError,
} from './brand.js';
import {
  parseISO, parseISOWall, hasZoneDesignator, hasUtcDesignator, toISO, toISODate, unpack, readFields,
  pad2, pad3, pad4, year6, daysFromCivil, MS_DAY, civilFromDays, dayIndexOf, isoDateOfDay,
  isRepresentable,
  daysInMonth as daysInMonthRaw, isLeapYear as isLeapYearRaw,
  dayOfWeekOfDay, dayOfYearOfDay, isoWeekOfDay, isoWeekYearOfDay,
  startOfMonthOfDay, startOfYearOfDay, startOfWeekOfDay, endOfMonthOfDay,
  addMonthsOfDay, diffMonthsOfDay,
  addMonths as addMonthsRaw, addYears as addYearsRaw,
  startOfDay as startOfDayRaw, startOfHour as startOfHourRaw,
  startOfMinute as startOfMinuteRaw, startOfMonth as startOfMonthRaw,
  startOfYear as startOfYearRaw, startOfWeek as startOfWeekRaw,
  diffDays as diffDaysRaw, diffMonths as diffMonthsRaw,
  dayOfWeek as isoDayOfWeekRaw, isoWeek, isoWeekYear, dayOfYear as dayOfYearRaw,
  getYear, getMonth, getDay, getHour, getMinute, getSecond, getMillisecond,
  type DateTimeFields,
} from './core.js';
import {
  offsetAt, utcFromWall, formatZoned, toZonedISODate, startOfDayZoned, formatLocale,
  namesATimeComponent,
  addDaysZoned, addMonthsZoned, zonedFields, type Disambiguation,
} from './zone.js';
import { cY, cM, cD, cH, cMi, cS, cMs } from './core.js';

// Module-local unit constants. Reading these through a cross-module import binding costs
// measurably more on one-line methods than a local const does.
const SEC = 1000, MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

// ============================================================ ChronoInstant

/**
 * A moment on the UTC timeline, to millisecond precision. **Immutable.**
 *
 * Deliberately has **no calendar fields**. A moment is not a year and a month until you
 * say which clock is reading it, so ask for one: {@link inZone} attaches a zone, and
 * {@link toUtcPlain} gives the UTC reading explicitly.
 *
 * @example
 * const t = ChronoInstant.parse('2024-03-15T10:30:00.000Z');
 * t.epochMilliseconds
 * t.addHours(3).toISOString()
 * t.inZone('Europe/Bratislava').hour      // 11 - a reading, through a zone
 * t.toUtcPlain().hour                     // 10 - the UTC reading, asked for by name
 */
export class ChronoInstant {
  /**
   * Epoch milliseconds. Branded, so a plain `number` will not type-check here and a
   * {@link WallMs} from {@link ChronoPlain} will not either.
   */
  readonly ms: EpochMs;

  /**
   * Wraps an already-validated instant. Performs **no** checking - the branded parameter
   * type is the guard. For untrusted input use {@link ChronoInstant.fromEpochMs}.
   */
  constructor(ms: EpochMs) {
    this.ms = ms;
  }

  /**
   * Parse an ISO-8601 string as a moment. A missing designator reads as **UTC**.
   *
   * If the string is a local reading rather than a moment, use {@link ChronoPlain.parse}
   * or {@link ChronoZoned.parse}, which do not assume UTC.
   *
   * **Throws `InvalidInstantError` (a `RangeError`) on malformed input**, matching
   * `Temporal.Instant.from`. Use {@link tryParse} when the input is untrusted.
   *
   * Returning a NaN-carrying instance instead was tried and withdrawn: NaN makes *both*
   * `a >= b` and `a < b` false, so a bad timestamp silently takes the else-branch of every
   * comparison rather than surfacing. A parser fed by an external API must fail closed.
   */
  static parse(s: string): ChronoInstant {
    const ms = parseISO(s);
    if (ms !== ms) throw new InvalidInstantError(s);
    return new ChronoInstant(ms);
  }

  /**
   * Like {@link parse}, but returns `null` instead of throwing. For untrusted input where
   * a bad value is expected and handled:
   *
   * ```ts
   * const t = ChronoInstant.tryParse(row.timestamp);
   * if (t === null) { logRejected(row); continue; }
   * ```
   */
  static tryParse(s: string): ChronoInstant | null {
    const ms = parseISO(s);
    return ms !== ms ? null : new ChronoInstant(ms);
  }

  /** Validates. Throws `InvalidInstantError` on NaN, Infinity, or out-of-range input. */
  static fromEpochMs(ms: number): ChronoInstant { return new ChronoInstant(checkedEpochMs(ms)); }

  /** The current moment. See also {@link Now}, which makes the choice of clock explicit. */
  static now(): ChronoInstant { return new ChronoInstant(unsafeEpochMs(Date.now())); }

  /** Convert from a native `Date`. The moment is preserved exactly. */
  static fromDate(d: Date): ChronoInstant {
    const ms = d.getTime();
    if (ms !== ms) throw new InvalidInstantError(ms);
    return new ChronoInstant(unsafeEpochMs(ms));
  }

  /** Comparator for `Array#sort`, earliest first. Only accepts moments. */
  static compare(a: ChronoInstant, b: ChronoInstant): -1 | 0 | 1 {
    return a.ms < b.ms ? -1 : a.ms > b.ms ? 1 : 0;
  }

  /** Milliseconds since 1970-01-01T00:00:00Z. */
  get epochMilliseconds(): number { return this.ms; }

  /** `false` if this came from parsing malformed input. */
  get isValid(): boolean { return isRepresentable(this.ms); }

  // ---- exact-time arithmetic; a calendar is not involved, so no zone is needed ----

  /** Exact-time addition. `n` may be negative. */
  addMilliseconds(n: number): ChronoInstant { return new ChronoInstant((this.ms + n) as EpochMs); }
  /** Add `n` seconds of elapsed time. */
  addSeconds(n: number): ChronoInstant { return new ChronoInstant((this.ms + n * SEC) as EpochMs); }
  /** Add `n` minutes of elapsed time. */
  addMinutes(n: number): ChronoInstant { return new ChronoInstant((this.ms + n * MIN) as EpochMs); }
  /** Add `n` hours of elapsed time. */
  addHours(n: number): ChronoInstant { return new ChronoInstant((this.ms + n * HOUR) as EpochMs); }
  /**
   * Add `n` spans of exactly 24 hours.
   *
   * Named `addDays` because on the UTC timeline a day is always 24 hours. It is **not** a
   * calendar day in a zone - for that, go through {@link inZone} first, where a day may be
   * 23 or 25 hours.
   */
  addDays(n: number): ChronoInstant { return new ChronoInstant((this.ms + n * DAY) as EpochMs); }

  /**
   * Elapsed milliseconds from this moment to `other`. Negative if `other` is earlier.
   *
   * TypeScript rejects `b - a` on objects, so the difference is a method. `<`, `>`, `<=`
   * and `>=` do work between two moments, via {@link valueOf}.
   */
  millisecondsUntil(other: ChronoInstant): number { return other.ms - this.ms; }
  /** Elapsed whole seconds to `other`, truncated toward zero. */
  secondsUntil(other: ChronoInstant): number {
    return Math.trunc((other.ms - this.ms) / SEC) || 0;
  }
  /** Elapsed whole minutes to `other`, truncated toward zero. */
  minutesUntil(other: ChronoInstant): number {
    return Math.trunc((other.ms - this.ms) / MIN) || 0;
  }
  /** Elapsed whole hours to `other`, truncated toward zero. */
  hoursUntil(other: ChronoInstant): number {
    return Math.trunc((other.ms - this.ms) / HOUR) || 0;
  }
  /** Elapsed whole 24-hour spans to `other`, truncated toward zero. */
  daysUntil(other: ChronoInstant): number {
    return Math.trunc((other.ms - this.ms) / DAY) || 0;
  }

  /** Same moment, to the millisecond. */
  equals(other: ChronoInstant): boolean { return this.ms === other.ms; }
  /** Strictly earlier than `other`. */
  isBefore(other: ChronoInstant): boolean { return this.ms < other.ms; }
  /** Strictly later than `other`. */
  isAfter(other: ChronoInstant): boolean { return this.ms > other.ms; }

  // ---- conversions: every route to calendar fields is named ----

  /** Same moment, read through `tz`. Throws `UnknownTimeZoneError` on a bad zone id. */
  inZone(tz: TimeZoneId | string): ChronoZoned { return new ChronoZoned(this.ms, checkedZone(tz)); }

  /**
   * The **UTC** reading of this moment, as a zone-free value.
   *
   * Spelled out rather than implicit: `instant.hour` does not exist precisely so that
   * reading UTC fields is a decision you can see in the code.
   */
  toUtcPlain(): ChronoPlain { return new ChronoPlain(unsafeWallMs(this.ms)); }

  /** Convert to a native `Date`. The moment is preserved exactly. */
  toDate(): Date { return new Date(this.ms); }

  /** `YYYY-MM-DDTHH:mm:ss.sssZ` - byte-identical to `Date#toISOString()`. */
  toISOString(): string { return toISO(this.ms); }
  /** `YYYY-MM-DD` in UTC. */
  toISODate(): string { return toISODate(this.ms); }
  /** Same as {@link toISOString}, but yields `'Invalid Date'` instead of throwing. */
  toString(): string { return isRepresentable(this.ms) ? toISO(this.ms) : 'Invalid Date'; }
  /**
   * Serialises to ISO-8601, so `JSON.stringify` round-trips through {@link parse}.
   * An invalid moment serialises to `null`, matching `Date#toJSON()` - a broken value must
   * not travel into JSON looking like a timestamp.
   */
  toJSON(): string | null { return isRepresentable(this.ms) ? toISO(this.ms) : null; }

  /**
   * Locale-aware text, through `Intl`. A moment has no zone of its own, so this renders in the **host** zone, matching
   * `Temporal.Instant#toLocaleString`. Use {@link inZone} first to pick the zone yourself.
   *
   * ```ts
   * t.toLocaleString('sk-SK')                       // '2. 9. 2026 14:30:00' (host zone)
   * t.inZone('Asia/Tokyo').toLocaleString('sk-SK')  // the same moment in Tokyo
   * ```
   *
   * Formatters are cached, so a repeated call costs ~1.2us rather than the ~46us of
   * building one. Without this method the call would silently resolve to
   * `Object.prototype.toLocaleString`, which ignores the locale and returns the ISO string.
   */
  toLocaleString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    return formatLocale(this.ms, Now.timeZoneId(), locales, options, 0);
  }
  /** Date only, in the caller's locale. */
  toLocaleDateString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    return formatLocale(this.ms, Now.timeZoneId(), locales, options, 1);
  }
  /** Time only, in the caller's locale. */
  toLocaleTimeString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    return formatLocale(this.ms, Now.timeZoneId(), locales, options, 2);
  }

  /** The epoch milliseconds, so `<`, `>` and `-` work between moments. */
  valueOf(): number { return this.ms; }
}

// ============================================================ ChronoPlain

/**
 * A clock reading with no zone and therefore **no moment**: `2024-03-15T10:30` is a year,
 * a month, a day and a time, and nothing more. **Immutable.**
 *
 * Deliberately has **no `epochMilliseconds` and no `toDate()`**. Until a zone says which
 * 10:30 is meant, there is no instant to hand out. {@link assumeZone} is the way across.
 *
 * This is the type for values that arrive without a zone - a date picker, a CSV column,
 * a legacy database field - and for `Temporal.PlainDateTime`.
 *
 * @example
 * const p = ChronoPlain.parse('2024-03-15T10:30');
 * p.hour                                  // 10
 * p.addDays(7).toPlainISOString()         // '2024-03-22T10:30:00'
 * p.assumeZone('Europe/Bratislava')       // now it is a moment
 */
export class ChronoPlain {
  /**
   * The reading, encoded as milliseconds **as if it were UTC**.
   *
   * Branded {@link WallMs} rather than {@link EpochMs} on purpose: the compiler will not
   * let this be used where a moment is expected, because it is not one.
   */
  readonly wall: WallMs;

  /** Wraps an already-validated reading. Performs no checking. */
  constructor(wall: WallMs) {
    this.wall = wall;
  }

  /**
   * Parse an ISO-8601 string as a clock reading. Any `Z` or offset in the string is
   * **ignored** - a reading has no offset. Use {@link ChronoInstant.parse} if you meant a
   * moment, or {@link ChronoZoned.parse} to resolve one against a zone.
   */
  static parse(s: string): ChronoPlain {
    const wall = parseISOWall(s);
    if (wall !== wall) throw new InvalidInstantError(s);
    return new ChronoPlain(wall);
  }

  /** Like {@link parse}, but returns `null` instead of throwing. */
  static tryParse(s: string): ChronoPlain | null {
    const wall = parseISOWall(s);
    return wall !== wall ? null : new ChronoPlain(wall);
  }

  /**
   * Build from calendar fields.
   * @param mo Month, **1-12**. January is 1.
   */
  static of(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): ChronoPlain {
    return new ChronoPlain(unsafeWallMs(
      daysFromCivil(y, mo, d) * MS_DAY + h * HOUR + mi * MIN + s * SEC + ms));
  }

  /** The current reading in `tz` - the system zone by default. */
  static now(tz?: TimeZoneId | string): ChronoPlain { return Now.plainDateTimeISO(tz); }

  /** Comparator for `Array#sort`, earliest reading first. Only accepts readings. */
  static compare(a: ChronoPlain, b: ChronoPlain): -1 | 0 | 1 {
    return a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : 0;
  }

  /** `false` if this came from parsing malformed input. */
  get isValid(): boolean { return isRepresentable(this.wall); }

  /** Calendar year. */
  get year(): number { return getYear(this.wall as unknown as EpochMs); }
  /** Month, **1-12**. January is `1`, not `0`. */
  get month(): number { return getMonth(this.wall as unknown as EpochMs); }
  /** Day of the month, **1-31**. */
  get day(): number { return getDay(this.wall as unknown as EpochMs); }
  /** Hour, **0-23**. */
  get hour(): number { return getHour(this.wall as unknown as EpochMs); }
  /** Minute, **0-59**. */
  get minute(): number { return getMinute(this.wall as unknown as EpochMs); }
  /** Second, **0-59**. */
  get second(): number { return getSecond(this.wall as unknown as EpochMs); }
  /** Millisecond, **0-999**. */
  get millisecond(): number { return getMillisecond(this.wall as unknown as EpochMs); }
  /** ISO day of week, **1 = Monday … 7 = Sunday**. */
  get dayOfWeek(): number { return isoDayOfWeekRaw(this.wall as unknown as EpochMs); }
  /** Day of the year, **1-366**. */
  get dayOfYear(): number { return dayOfYearRaw(this.wall as unknown as EpochMs); }
  /** ISO-8601 week number, **1-53**. */
  get weekOfYear(): number { return isoWeek(this.wall as unknown as EpochMs); }
  /** ISO week-numbering year, which can differ from {@link year} at a year boundary. */
  get weekYear(): number { return isoWeekYear(this.wall as unknown as EpochMs); }

  /** All seven fields from a single civil conversion. */
  fields(): DateTimeFields { unpack(this.wall); return readFields(); }

  // ---- calendar arithmetic; no zone is involved, so no DST is involved either ----

  /** Add `n` milliseconds to the reading. */
  addMilliseconds(n: number): ChronoPlain { return new ChronoPlain((this.wall + n) as WallMs); }
  /** Add `n` seconds to the reading. */
  addSeconds(n: number): ChronoPlain { return new ChronoPlain((this.wall + n * SEC) as WallMs); }
  /** Add `n` minutes to the reading. */
  addMinutes(n: number): ChronoPlain { return new ChronoPlain((this.wall + n * MIN) as WallMs); }
  /** Add `n` hours to the reading. */
  addHours(n: number): ChronoPlain { return new ChronoPlain((this.wall + n * HOUR) as WallMs); }
  /** Add `n` days to the reading. Always exactly 24 hours - a reading has no DST. */
  addDays(n: number): ChronoPlain { return new ChronoPlain((this.wall + n * DAY) as WallMs); }
  /** Add `n * 7` days to the reading. */
  addWeeks(n: number): ChronoPlain { return new ChronoPlain((this.wall + n * 7 * DAY) as WallMs); }
  /**
   * Add `n` calendar months, **clamping to the end of the target month**.
   * @example ChronoPlain.parse('2024-01-31').addMonths(1).toISODate()   // '2024-02-29'
   */
  addMonths(n: number): ChronoPlain {
    return new ChronoPlain(unsafeWallMs(addMonthsRaw(this.wall as unknown as EpochMs, n)));
  }
  /** Add `n * 12` months, clamping. */
  addYears(n: number): ChronoPlain {
    return new ChronoPlain(unsafeWallMs(addYearsRaw(this.wall as unknown as EpochMs, n)));
  }

  /** Truncate to the start of this minute. */
  startOfMinute(): ChronoPlain { return new ChronoPlain(unsafeWallMs(startOfMinuteRaw(this.wall as unknown as EpochMs))); }
  /** Truncate to the top of this hour. */
  startOfHour(): ChronoPlain { return new ChronoPlain(unsafeWallMs(startOfHourRaw(this.wall as unknown as EpochMs))); }
  /** Midnight of this day. */
  startOfDay(): ChronoPlain { return new ChronoPlain(unsafeWallMs(startOfDayRaw(this.wall as unknown as EpochMs))); }
  /**
   * Midnight on the first day of this week.
   * @param firstDay `0` = Sunday … `6` = Saturday. Defaults to `1`, Monday (ISO).
   */
  startOfWeek(firstDay?: number): ChronoPlain {
    return new ChronoPlain(unsafeWallMs(startOfWeekRaw(this.wall as unknown as EpochMs, firstDay)));
  }
  /** Midnight on the first day of this month. */
  startOfMonth(): ChronoPlain { return new ChronoPlain(unsafeWallMs(startOfMonthRaw(this.wall as unknown as EpochMs))); }
  /** Midnight on 1 January of this year. */
  startOfYear(): ChronoPlain { return new ChronoPlain(unsafeWallMs(startOfYearRaw(this.wall as unknown as EpochMs))); }

  /** Whole calendar days from this reading to `other`. */
  daysUntil(other: ChronoPlain): number {
    return diffDaysRaw(this.wall as unknown as EpochMs, other.wall as unknown as EpochMs);
  }
  /** Whole calendar months from this reading to `other`, truncated toward zero. */
  monthsUntil(other: ChronoPlain): number {
    return diffMonthsRaw(this.wall as unknown as EpochMs, other.wall as unknown as EpochMs);
  }

  /** Elapsed milliseconds between the two readings. Negative if `other` is earlier. */
  millisecondsUntil(other: ChronoPlain): number { return other.wall - this.wall; }
  /** Whole minutes between the two readings, truncated toward zero. */
  minutesUntil(other: ChronoPlain): number {
    return Math.trunc((other.wall - this.wall) / MIN) || 0;
  }
  /** Whole hours between the two readings, truncated toward zero. */
  hoursUntil(other: ChronoPlain): number {
    return Math.trunc((other.wall - this.wall) / HOUR) || 0;
  }

  /**
   * The underlying reading, so `<`, `>`, `<=` and `>=` order two readings correctly.
   *
   * Without this, JavaScript falls back to comparing the ISO strings, which is subtly
   * wrong: `'+010000-01-01'` sorts before `'2024-03-15'` because `'+'` precedes `'2'`.
   *
   * TypeScript refuses to compare a `ChronoPlain` with a `ChronoInstant` directly - the
   * operator rejects mixed operand types. **Plain JavaScript does not**, and neither does
   * TypeScript once you unwrap both sides yourself: `p.valueOf() < i.valueOf()` compares a
   * wall clock against an epoch instant and quietly answers with whichever number is
   * larger. The two are different coordinate systems; convert with {@link assumeZone}
   * before comparing across them.
   */
  valueOf(): number { return this.wall; }

  /**
   * Locale-aware text, through `Intl`. The reading is rendered **exactly as written** - a
   * `timeZone` option is ignored, because a wall clock with no zone has no moment to
   * shift. Same rule as `Temporal.PlainDateTime#toLocaleString`.
   *
   * ```ts
   * p.toLocaleString('sk-SK')                                  // '2. 9. 2026 14:30:00'
   * p.toLocaleDateString('sk-SK', { month: 'long', day: 'numeric', year: 'numeric' })
   * //  '2. septembra 2026'
   * ```
   *
   * Formatters are cached, so a repeated call costs ~1.2us rather than the ~46us of
   * building one. Without this method the call would silently resolve to
   * `Object.prototype.toLocaleString`, which ignores the locale and returns the ISO string.
   */
  toLocaleString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    return formatLocale(this.wall, 'UTC', locales, options, 0);
  }
  /** Date only, in the caller's locale. */
  toLocaleDateString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    return formatLocale(this.wall, 'UTC', locales, options, 1);
  }
  /** Time only, in the caller's locale. */
  toLocaleTimeString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    return formatLocale(this.wall, 'UTC', locales, options, 2);
  }

  /** Same reading, to the millisecond. */
  equals(other: ChronoPlain): boolean { return this.wall === other.wall; }
  /** Strictly earlier reading than `other`. */
  isBefore(other: ChronoPlain): boolean { return this.wall < other.wall; }
  /** Strictly later reading than `other`. */
  isAfter(other: ChronoPlain): boolean { return this.wall > other.wall; }

  // ---- the only route to a moment ----

  /**
   * Declare which zone this reading was taken in, producing a real moment.
   *
   * Named `assumeZone` because that is what it does: you are asserting knowledge the value
   * did not carry. The offset is resolved for this date, so DST is handled rather than
   * assumed.
   *
   * @param disambiguation What to do on the two days a year when the reading is ambiguous
   *                       or does not exist. Defaults to Temporal's `'compatible'`.
   */
  assumeZone(tz: TimeZoneId | string, disambiguation: Disambiguation = 'compatible'): ChronoZoned {
    const zoneId = checkedZone(tz);
    return new ChronoZoned(utcFromWall(zoneId, this.wall, disambiguation), zoneId);
  }

  /**
   * `YYYY-MM-DDTHH:mm:ss` with no `Z` and no trailing zeros in the fraction - the same text
   * `Temporal.PlainDateTime#toString()` produces.
   */
  toPlainISOString(): string {
    if (!isRepresentable(this.wall)) throw new RangeError('Invalid time value');
    unpack(this.wall);
    let frac = '';
    if (cMs !== 0) {
      const d3 = pad3(cMs);
      frac = '.' + (d3.charCodeAt(2) !== 48 ? d3 : d3.charCodeAt(1) !== 48 ? d3.slice(0, 2) : d3.slice(0, 1));
    }
    // Years outside 0..9999 need the ISO expanded form with an explicit sign; pad4 would
    // pad in front of the minus and emit '000-110091'.
    const y = cY >= 0 && cY <= 9999 ? pad4(cY) : year6(cY);
    return y + '-' + pad2(cM) + '-' + pad2(cD) + 'T' +
           pad2(cH) + ':' + pad2(cMi) + ':' + pad2(cS) + frac;
  }

  /**
   * Drop the time and keep the calendar date, as a {@link ChronoDate}. The result cannot
   * carry a time at all, which is the difference between this and `startOfDay()`.
   */
  toPlainDate(): ChronoDate {
    return new ChronoDate(dayIndexOf(this.wall));
  }

  /** `YYYY-MM-DD`. Identical to `Temporal.PlainDate#toString()`. */
  toISODate(): string { return toISODate(this.wall as unknown as EpochMs); }
  /** Same as {@link toPlainISOString}, but yields `'Invalid Date'` instead of throwing. */
  toString(): string { return isRepresentable(this.wall) ? this.toPlainISOString() : 'Invalid Date'; }
  /**
   * Serialises without a `Z`, because the reading carries no offset to claim.
   * An invalid reading serialises to `null`, matching `Date#toJSON()`.
   */
  toJSON(): string | null { return isRepresentable(this.wall) ? this.toPlainISOString() : null; }
}

// ============================================================ ChronoDate

/**
 * A **calendar date** - a year, a month and a day, with no time of day and no zone.
 * The equivalent of `Temporal.PlainDate`.
 *
 * ```ts
 * const d = ChronoDate.parse('2024-03-15');
 * d.addDays(7).toISODate()        // '2024-03-22'
 * d.addMonths(1).toISODate()      // '2024-04-15'
 * ChronoDate.parse('2024-01-31').addMonths(1).toISODate()   // '2024-02-29', clamped
 * ```
 *
 * **It has no `hour`, and no `addHours`.** That is the point of the type: a birthday, an
 * invoice date or a hotel night is not a moment, and code that reads a time off one is
 * asking a question the value cannot answer. To get a time, ask for one explicitly:
 *
 * ```ts
 * d.toPlain()                     // ChronoPlain at 00:00 - the time is now 0, visibly
 * d.atTime(14, 30)                // ChronoPlain at 14:30
 * d.atStartOfDay('Europe/Bratislava')   // ChronoZoned - a real moment, DST-correct
 * ```
 *
 * Stored as a **day index** (days since 1970-01-01), not a timestamp. A midnight timestamp
 * in 2024 is ~1.7e12 and gets boxed by V8; a day index is ~19,800 and stays an immediate,
 * so comparison, sorting and arithmetic all stay in integer registers.
 */
export class ChronoDate {
  /** Days since 1970-01-01. Negative before it. */
  readonly dayIndex: DayIndex;

  /** Wraps a day index directly. Prefer {@link parse}, {@link of} or {@link now}. */
  constructor(dayIndex: DayIndex | number) {
    this.dayIndex = dayIndex as DayIndex;
  }

  /**
   * Parse an ISO-8601 date. A bare time component is accepted and discarded
   * (`'2024-03-15T10:30'` is 15 March), matching `Temporal.PlainDate.from`.
   *
   * **A trailing `Z` is rejected**, matching Temporal, and for a reason worth spelling
   * out: `Z` says the string is a moment in UTC and carries no local clock, so which
   * calendar day it lands on depends on a zone the string does not name.
   * `'2024-03-15T23:30:00Z'` is 15 March in UTC but 16 March in Bratislava, so silently
   * taking the UTC date would hand back the wrong day for half the world. An explicit
   * offset like `'+01:00'` **is** accepted, because it still describes a local wall clock
   * and the date as written is the date meant - again matching Temporal. To go from a
   * moment to a date, say which zone decides:
   *
   * ```ts
   * ChronoInstant.parse(s).inZone(tz).toPlainDate()
   * ```
   *
   * Throws `InvalidInstantError` (a `RangeError`) on malformed input; see {@link tryParse}.
   */
  static parse(s: string): ChronoDate {
    const wall = parseISOWall(s);
    if (wall !== wall || hasUtcDesignator(s)) throw new InvalidInstantError(s);
    return new ChronoDate(dayIndexOf(wall));
  }

  /** Like {@link parse}, but returns `null` instead of throwing. */
  static tryParse(s: string): ChronoDate | null {
    const wall = parseISOWall(s);
    return wall !== wall || hasUtcDesignator(s) ? null : new ChronoDate(dayIndexOf(wall));
  }

  /**
   * Build from calendar fields.
   * @param m Month, **1-12** - January is 1, not 0.
   */
  static of(y: number, m: number, d: number): ChronoDate {
    return new ChronoDate(unsafeDayIndex(daysFromCivil(y, m, d)));
  }

  /** Today's date in `tz`, or in the host zone when omitted. */
  static now(tz?: TimeZoneId | string): ChronoDate {
    const ms = unsafeEpochMs(Date.now());
    const zoneId = checkedZone(tz === undefined ? Now.timeZoneId() : tz);
    return new ChronoDate(dayIndexOf(ms + offsetAt(zoneId, ms)));
  }

  /** Comparator for `Array#sort`, earliest first. */
  static compare(a: ChronoDate, b: ChronoDate): -1 | 0 | 1 {
    return a.dayIndex < b.dayIndex ? -1 : a.dayIndex > b.dayIndex ? 1 : 0;
  }

  /** `false` if this was built from a NaN day index. */
  get isValid(): boolean { return isRepresentable(this.dayIndex * MS_DAY); }

  /** Calendar year. Negative before 1 CE. */
  get year(): number { civilFromDays(this.dayIndex); return cY; }
  /** Calendar month, **1-12** - January is 1, not 0. */
  get month(): number { civilFromDays(this.dayIndex); return cM; }
  /** Day of the month, **1-31**. */
  get day(): number { civilFromDays(this.dayIndex); return cD; }
  /** ISO day of week, **1-7** - Monday is 1, Sunday is 7. */
  get dayOfWeek(): number { return dayOfWeekOfDay(this.dayIndex); }
  /** Day of the year, **1-366**. */
  get dayOfYear(): number { return dayOfYearOfDay(this.dayIndex); }
  /** ISO-8601 week number, **1-53**. See {@link weekYear}. */
  get weekOfYear(): number { return isoWeekOfDay(this.dayIndex); }
  /** The year that owns {@link weekOfYear}, which near New Year is not {@link year}. */
  get weekYear(): number { return isoWeekYearOfDay(this.dayIndex); }
  /** Days in this date's month, **28-31**. */
  get daysInMonth(): number { civilFromDays(this.dayIndex); return daysInMonthRaw(cY, cM); }
  /** Days in this date's year, 365 or 366. */
  get daysInYear(): number { civilFromDays(this.dayIndex); return isLeapYearRaw(cY) ? 366 : 365; }
  /** Whether this date's year is a leap year. */
  get inLeapYear(): boolean { civilFromDays(this.dayIndex); return isLeapYearRaw(cY); }

  /** Year, month and day from a single civil conversion. Cheaper than three getters. */
  fields(): { year: number; month: number; day: number } {
    civilFromDays(this.dayIndex);
    return { year: cY, month: cM, day: cD };
  }

  /** Add `n` days. One integer add - no calendar conversion at all. */
  addDays(n: number): ChronoDate { return new ChronoDate(unsafeDayIndex(this.dayIndex + n)); }
  /** Add `n * 7` days. */
  addWeeks(n: number): ChronoDate { return new ChronoDate(unsafeDayIndex(this.dayIndex + n * 7)); }
  /** Add `n` calendar months, **clamping to the end of the target month**. */
  addMonths(n: number): ChronoDate {
    return new ChronoDate(unsafeDayIndex(addMonthsOfDay(this.dayIndex, n)));
  }
  /** Add `n` calendar years. 29 Feb + 1 year is 28 Feb. */
  addYears(n: number): ChronoDate {
    return new ChronoDate(unsafeDayIndex(addMonthsOfDay(this.dayIndex, n * 12)));
  }

  /** The first day of this month. */
  startOfMonth(): ChronoDate {
    return new ChronoDate(unsafeDayIndex(startOfMonthOfDay(this.dayIndex)));
  }
  /** The last day of this month. */
  endOfMonth(): ChronoDate {
    return new ChronoDate(unsafeDayIndex(endOfMonthOfDay(this.dayIndex)));
  }
  /** 1 January of this year. */
  startOfYear(): ChronoDate {
    return new ChronoDate(unsafeDayIndex(startOfYearOfDay(this.dayIndex)));
  }
  /** @param firstDay 1 = Monday (the ISO default), 7 = Sunday. */
  startOfWeek(firstDay = 1): ChronoDate {
    return new ChronoDate(unsafeDayIndex(startOfWeekOfDay(this.dayIndex, firstDay)));
  }

  /** Whole days from this date to `other`. Negative if `other` is earlier. One subtract. */
  daysUntil(other: ChronoDate): number { return other.dayIndex - this.dayIndex; }
  /** Whole weeks from this date to `other`, truncated toward zero. */
  weeksUntil(other: ChronoDate): number {
    return Math.trunc((other.dayIndex - this.dayIndex) / 7) || 0;
  }
  /** Whole calendar months from this date to `other`, truncated toward zero. */
  monthsUntil(other: ChronoDate): number {
    return diffMonthsOfDay(this.dayIndex, other.dayIndex);
  }
  /** Whole calendar years from this date to `other`, truncated toward zero. */
  yearsUntil(other: ChronoDate): number {
    return Math.trunc(diffMonthsOfDay(this.dayIndex, other.dayIndex) / 12) || 0;
  }

  /** Same calendar date. */
  equals(other: ChronoDate): boolean { return this.dayIndex === other.dayIndex; }
  /** Strictly earlier than `other`. */
  isBefore(other: ChronoDate): boolean { return this.dayIndex < other.dayIndex; }
  /** Strictly later than `other`. */
  isAfter(other: ChronoDate): boolean { return this.dayIndex > other.dayIndex; }

  /**
   * This date at **00:00**, as a wall-clock reading. The time is zero, and now visibly so.
   * @param h Hour, 0-23. Defaults to midnight; see also {@link atTime}.
   */
  toPlain(h = 0, mi = 0, s = 0, msec = 0): ChronoPlain {
    return new ChronoPlain(unsafeWallMs(
      this.dayIndex * MS_DAY + h * 3_600_000 + mi * 60_000 + s * 1000 + msec));
  }

  /** This date at a given wall-clock time. `d.atTime(14, 30)` reads 14:30 on that date. */
  atTime(h: number, mi = 0, s = 0, msec = 0): ChronoPlain {
    return this.toPlain(h, mi, s, msec);
  }

  /**
   * The first moment of this date in `tz` - an actual instant, so DST is applied. On a
   * spring-forward day where midnight does not exist this is 01:00, not 00:00.
   */
  atStartOfDay(tz: TimeZoneId | string, disambiguation: Disambiguation = 'compatible'): ChronoZoned {
    const zoneId = checkedZone(tz);
    // The day index is a LOCAL date, so it names a wall clock, not an instant. Feeding
    // `dayIndex * MS_DAY` to startOfDayZoned as if it were UTC lands in the previous day
    // for every zone west of Greenwich.
    return new ChronoZoned(
      utcFromWall(zoneId, unsafeWallMs(this.dayIndex * MS_DAY), disambiguation), zoneId);
  }

  /** `YYYY-MM-DD`. Identical to `Temporal.PlainDate#toString()`. */
  toISODate(): string { return isoDateOfDay(this.dayIndex); }
  /** Same as {@link toISODate}, but yields `'Invalid Date'` instead of throwing. */
  toString(): string {
    return this.isValid ? isoDateOfDay(this.dayIndex) : 'Invalid Date';
  }
  /** Serialises as `YYYY-MM-DD`; an invalid date serialises to `null`, like `Date`. */
  toJSON(): string | null {
    return this.isValid ? isoDateOfDay(this.dayIndex) : null;
  }

  /**
   * Locale-aware text, through `Intl`. The date is rendered **exactly as written**; a `timeZone` option is ignored, as it
   * is on `Temporal.PlainDate#toLocaleString`.
   *
   * ```ts
   * d.toLocaleDateString('sk-SK')                              // '2. 9. 2026'
   * d.toLocaleDateString('sk-SK', { month: 'long', day: 'numeric', year: 'numeric' })
   * //  '2. septembra 2026'
   * ```
   *
   * Formatters are cached, so a repeated call costs ~1.2us rather than the ~46us of
   * building one. Without this method the call would silently resolve to
   * `Object.prototype.toLocaleString`, which ignores the locale and returns the ISO string.
   */
  toLocaleString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    return this.#localised(locales, options);
  }
  /** Identical to {@link toLocaleString}; a date has only a date to render. */
  toLocaleDateString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    return this.#localised(locales, options);
  }

  /**
   * Asking a date to render a time is refused, not answered with midnight.
   *
   * `{ hour: '2-digit' }` used to print `'00'`, which is the plausible-wrong-answer shape
   * this whole type exists to remove - the same reason it has no `hour` getter.
   * `Temporal.PlainDate#toLocaleString` throws a `TypeError` on the same options, so this
   * does too. There is no `toLocaleTimeString` here for the same reason.
   */
  #localised(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    if (namesATimeComponent(options)) {
      throw new TypeError('Invalid formatting options: a ChronoDate has no time of day');
    }
    return formatLocale(this.dayIndex * MS_DAY, 'UTC', locales, options, 1);
  }

  /** The day index, so `<`, `>` and `-` work between dates. `b - a` is whole days. */
  valueOf(): number { return this.dayIndex; }
}

// ============================================================ ChronoZoned

// Case-insensitive equality for IANA ids, which are ASCII by construction (letters, digits,
// `_`, `/`, `-`, `.`, `+`), so folding A-Z to a-z char-by-char is exact. Not `toLowerCase`:
// that allocates two strings per comparison, and {@link ChronoZoned.withZoneSameLocal} runs
// it on every call - for a cross-zone call the check always fails, and the allocations were
// measured to nearly double the method (~30ns -> ~60ns). Different-length ids and ids that
// diverge on an early character reject in a couple of charCodeAt calls.
//
// The fold is `| 32` rather than a range test: ASCII case is exactly bit 5, and every other
// character an IANA id can contain (digits, `_ / - + .`) already has bit 5 set, so OR-ing
// changes nothing but the letters. Measured ~30% faster on a full-length recased match than
// comparing `x >= 65 && x <= 90` per character.
const sameZoneId = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a.charCodeAt(i) | 32) !== (b.charCodeAt(i) | 32)) return false;
  }
  return true;
};

/**
 * A moment, read through an IANA zone. **Immutable.**
 *
 * The only type that legitimately has both an instant and calendar fields, because a zone
 * is exactly what connects them.
 */
export class ChronoZoned {
  /** Epoch milliseconds - the moment itself, independent of {@link tz}. */
  readonly ms: EpochMs;
  /** The IANA zone id this moment is read through, e.g. `'Europe/Bratislava'`. */
  readonly tz: TimeZoneId | string;

  /** Wraps an already-validated moment and zone. Performs no checking. */
  constructor(ms: EpochMs, tz: TimeZoneId | string) {
    this.ms = ms;
    this.tz = tz;
  }

  /**
   * Parse a string as a moment in `tz`, deciding by whether it carries a designator:
   *
   * - `'2000-09-01T10:00:00Z'` or `'...+05:00'` - an exact moment, displayed in `tz`.
   * - `'2000-09-01T10:00'` or `'2000-09-01'` - a **reading in `tz`**, resolved using that
   *   date's offset. So this round-trips as 10:00, not 12:00.
   */
  static parse(
    s: string,
    tz: TimeZoneId | string,
    disambiguation: Disambiguation = 'compatible',
  ): ChronoZoned {
    const zoneId = checkedZone(tz);
    const ms = parseISO(s);
    if (ms !== ms) throw new InvalidInstantError(s);
    if (hasZoneDesignator(s)) return new ChronoZoned(ms, zoneId);
    return new ChronoZoned(utcFromWall(zoneId, unsafeWallMs(ms), disambiguation), zoneId);
  }

  /** Like {@link parse}, but returns `null` instead of throwing on malformed input. */
  static tryParse(
    s: string,
    tz: TimeZoneId | string,
    disambiguation: Disambiguation = 'compatible',
  ): ChronoZoned | null {
    const ms = parseISO(s);
    if (ms !== ms) return null;
    const zoneId = checkedZone(tz);
    if (hasZoneDesignator(s)) return new ChronoZoned(ms, zoneId);
    try {
      return new ChronoZoned(utcFromWall(zoneId, unsafeWallMs(ms), disambiguation), zoneId);
    } catch (error) {
      if (error instanceof InvalidInstantError) return null;
      throw error;
    }
  }

  /** An exact moment, read through `tz`. Validates both arguments. */
  static fromEpochMs(ms: number, tz: TimeZoneId | string): ChronoZoned {
    return new ChronoZoned(checkedEpochMs(ms), checkedZone(tz));
  }

  /**
   * Interpret local wall-clock fields in `tz`.
   * @param mo Month, **1-12**.
   */
  static fromLocal(
    tz: TimeZoneId | string,
    y: number, mo: number, d: number,
    h = 0, mi = 0, s = 0, msec = 0,
    disambiguation: Disambiguation = 'compatible',
  ): ChronoZoned {
    return ChronoPlain.of(y, mo, d, h, mi, s, msec).assumeZone(tz, disambiguation);
  }

  /** The current moment in `tz` - the system zone by default. */
  static now(tz?: TimeZoneId | string): ChronoZoned { return Now.zonedDateTimeISO(tz); }

  /** Comparator for `Array#sort`, earliest first. Zones may differ; the moment is compared. */
  static compare(a: ChronoZoned, b: ChronoZoned): -1 | 0 | 1 {
    return a.ms < b.ms ? -1 : a.ms > b.ms ? 1 : 0;
  }

  /** Milliseconds since the epoch. Independent of the zone. */
  get epochMilliseconds(): number { return this.ms; }
  /** `false` if this came from parsing malformed input. */
  get isValid(): boolean { return isRepresentable(this.ms); }
  /** UTC offset in **milliseconds** at this moment, e.g. `7200000` for +02:00. */
  get offset(): number { return offsetAt(this.tz, this.ms); }
  /** UTC offset in hours, fractional for zones like `+05:45`. */
  get offsetHours(): number { return offsetAt(this.tz, this.ms) / HOUR; }

  /** Local calendar year in this zone. */
  get year(): number { zonedFields(this.tz, this.ms); return cY; }
  /** Local month, **1-12**. January is `1`. */
  get month(): number { zonedFields(this.tz, this.ms); return cM; }
  /** Local day of the month, **1-31**. */
  get day(): number { zonedFields(this.tz, this.ms); return cD; }
  /** Local hour, **0-23**. */
  get hour(): number { zonedFields(this.tz, this.ms); return cH; }
  /** Local minute, **0-59**. */
  get minute(): number { zonedFields(this.tz, this.ms); return cMi; }
  /** Local second, **0-59**. */
  get second(): number { zonedFields(this.tz, this.ms); return cS; }
  /** Millisecond, **0-999**. Identical in every zone; offsets are whole seconds. */
  get millisecond(): number { zonedFields(this.tz, this.ms); return cMs; }
  /** Local ISO day of week, **1 = Monday … 7 = Sunday**. */
  get dayOfWeek(): number { return this.toPlain().dayOfWeek; }
  /** Local day of the year, **1-366**. */
  get dayOfYear(): number { return this.toPlain().dayOfYear; }
  /** Local ISO-8601 week number, **1-53**. */
  get weekOfYear(): number { return this.toPlain().weekOfYear; }
  /** Local ISO week-numbering year. */
  get weekYear(): number { return this.toPlain().weekYear; }

  /** All seven local fields from a single zone lookup and one civil conversion. */
  fields(): DateTimeFields { zonedFields(this.tz, this.ms); return readFields(); }

  /** Exactly `n` hours of elapsed time. Unaffected by DST. */
  addHours(n: number): ChronoZoned { return new ChronoZoned((this.ms + n * HOUR) as EpochMs, this.tz); }
  /** Exactly `n` minutes of elapsed time. Unaffected by DST. */
  addMinutes(n: number): ChronoZoned { return new ChronoZoned((this.ms + n * MIN) as EpochMs, this.tz); }
  /** Exactly `n` seconds of elapsed time. Unaffected by DST. */
  addSeconds(n: number): ChronoZoned { return new ChronoZoned((this.ms + n * SEC) as EpochMs, this.tz); }

  /**
   * Adds `n` **calendar** days: the same wall-clock time on a later date. Across a DST
   * boundary this moves 23 or 25 hours, not 24. For exactly 24 hours use `addHours(24)`.
   */
  addDays(n: number): ChronoZoned { return new ChronoZoned(addDaysZoned(this.tz, this.ms, n), this.tz); }
  /** Adds `n` calendar months in local time, clamping to the end of the target month. */
  addMonths(n: number): ChronoZoned { return new ChronoZoned(addMonthsZoned(this.tz, this.ms, n), this.tz); }
  /** Adds `n * 12` calendar months in local time, clamping. */
  addYears(n: number): ChronoZoned { return new ChronoZoned(addMonthsZoned(this.tz, this.ms, n * 12), this.tz); }

  /** Local midnight of this day. Correct when local midnight does not exist. */
  startOfDay(): ChronoZoned { return new ChronoZoned(startOfDayZoned(this.tz, this.ms), this.tz); }

  /** Elapsed milliseconds from this moment to `other`. Zones may differ. */
  millisecondsUntil(other: ChronoZoned): number { return other.ms - this.ms; }
  /** Elapsed whole minutes to `other`, truncated toward zero. */
  minutesUntil(other: ChronoZoned): number {
    return Math.trunc((other.ms - this.ms) / MIN) || 0;
  }
  /** Elapsed whole hours to `other`, truncated toward zero. */
  hoursUntil(other: ChronoZoned): number {
    return Math.trunc((other.ms - this.ms) / HOUR) || 0;
  }
  /**
   * Whole **calendar** days between the local readings, not 24-hour spans - so a day that
   * crosses a DST boundary still counts as one.
   */
  daysUntil(other: ChronoZoned): number { return this.toPlain().daysUntil(other.toPlain()); }
  /** Whole calendar months between the local readings, truncated toward zero. */
  monthsUntil(other: ChronoZoned): number { return this.toPlain().monthsUntil(other.toPlain()); }

  /** Same moment, to the millisecond. Zones may differ. */
  equals(other: ChronoZoned): boolean { return this.ms === other.ms; }
  /** Strictly earlier than `other`. */
  isBefore(other: ChronoZoned): boolean { return this.ms < other.ms; }
  /** Strictly later than `other`. */
  isAfter(other: ChronoZoned): boolean { return this.ms > other.ms; }

  /** Same moment, read through another zone. The moment is unchanged. */
  withZone(tz: TimeZoneId | string): ChronoZoned { return new ChronoZoned(this.ms, checkedZone(tz)); }

  /**
   * Same wall-clock reading, in another zone. The reading is unchanged; the moment moves.
   * 09:00 in London becomes 09:00 in New York, five hours later.
   * Omitting `disambiguation` while naming the current zone is an exact identity. Pass a
   * mode explicitly to re-resolve an ambiguous reading in that zone.
   */
  withZoneSameLocal(tz: TimeZoneId | string, disambiguation?: Disambiguation): ChronoZoned {
    // Reinterpreting an unchanged reading in its current zone is an identity, including
    // when this instant is the later occurrence of an ambiguous wall-clock time. IANA ids
    // are case-insensitive, even though Intl preserves the caller's spelling here. Only an
    // omitted mode can take it: a mode given explicitly is a request to re-resolve, and
    // gets exactly the same code path as before this shortcut existed.
    if (disambiguation === undefined && sameZoneId(tz, this.tz)) {
      return new ChronoZoned(this.ms, checkedZone(tz));
    }
    return this.toPlain().assumeZone(tz, disambiguation ?? 'compatible');
  }

  /** The moment, without the zone. */
  toInstant(): ChronoInstant { return new ChronoInstant(this.ms); }
  /** The local reading, without the zone - and therefore without a moment. */
  toPlain(): ChronoPlain { return new ChronoPlain(unsafeWallMs(this.ms + offsetAt(this.tz, this.ms))); }
  /** Convert to a native `Date`. The moment is preserved; the zone is lost. */
  toDate(): Date { return new Date(this.ms); }

  /** Local ISO-8601 with offset, e.g. `2024-03-15T11:30:00.123+01:00`. No zone id. */
  toISOString(): string { return formatZoned(this.tz, this.ms); }
  /**
   * The **local** calendar date in this zone, as a {@link ChronoDate}. This is the correct
   * way to turn a moment into a date: which day an instant falls on is a question only a
   * zone can answer, and this one has it.
   */
  toPlainDate(): ChronoDate {
    return new ChronoDate(dayIndexOf(this.ms + offsetAt(this.tz, this.ms)));
  }

  /** Local `YYYY-MM-DD`, which can differ from the UTC date. */
  toISODate(): string { return toZonedISODate(this.tz, this.ms); }
  /**
   * Local ISO with the zone id appended, e.g. `...+01:00[Europe/Bratislava]`.
   * Yields `'Invalid Date'` instead of throwing.
   */
  toString(): string {
    return isRepresentable(this.ms) ? formatZoned(this.tz, this.ms) + '[' + this.tz + ']' : 'Invalid Date';
  }
  /**
   * Serialises with its offset but without the zone id. Store `tz` separately if needed.
   * An invalid moment serialises to `null`, matching `Date#toJSON()`.
   */
  toJSON(): string | null { return isRepresentable(this.ms) ? formatZoned(this.tz, this.ms) : null; }

  /**
   * Locale-aware text, through `Intl`. Rendered in **this value's own zone**, so `timeZoneName` options resolve correctly.
   *
   * ```ts
   * z.toLocaleString('sk-SK')                                  // '2. 9. 2026 14:30:00'
   * z.toLocaleString('sk-SK', { timeZoneName: 'short' })       // '... SELC'
   * ```
   *
   * Formatters are cached, so a repeated call costs ~1.2us rather than the ~46us of
   * building one. Without this method the call would silently resolve to
   * `Object.prototype.toLocaleString`, which ignores the locale and returns the ISO string.
   */
  toLocaleString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    return formatLocale(this.ms, this.tz, locales, options, 3);
  }
  /** Date only, in the caller's locale. */
  toLocaleDateString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    return formatLocale(this.ms, this.tz, locales, options, 1);
  }
  /** Time only, in the caller's locale. */
  toLocaleTimeString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string {
    return formatLocale(this.ms, this.tz, locales, options, 2);
  }

  /** The epoch milliseconds, so `<`, `>` and `-` compare moments across zones. */
  valueOf(): number { return this.ms; }
}

// ============================================================ Now

let systemZone: string | null = null;
let systemZoneAt = 0;

/**
 * How long a resolved system zone is trusted, in milliseconds.
 *
 * One second bounds the staleness a host zone change can cause while costing one `Intl`
 * resolve per second in the worst case - about 0.004% of a busy second. `Temporal.Now`
 * re-reads on every call and pays ~37us each time; this is the same answer, amortised.
 */
const ZONE_CACHE_MS = 1000;

/**
 * Reading the current time, with the ambiguity made explicit.
 *
 * "Now" is not one value. At 09:07 in Bratislava the moment and the local reading are two
 * different things, and picking the wrong one used to be silent. Each method here returns
 * a **different type**, so the choice is visible in the code and enforced by the compiler.
 *
 * The names mirror `Temporal.Now`, so migrating is a rename of `Temporal.Now.x()` to
 * `Now.x()`.
 *
 * @example
 * // the local clock says 09:07
 * Now.instant()             // ChronoInstant - a moment; no .hour to misread
 * Now.plainDateTimeISO()    // ChronoPlain   - .hour is 9
 * Now.zonedDateTimeISO()    // ChronoZoned   - .hour is 9, carries its zone
 */
export const Now = {
  /**
   * The system time zone id, e.g. `'Europe/Bratislava'`.
   *
   * **Cached, but only briefly.** Asking the host costs ~37us against ~6ns for a cached
   * read, so caching is not optional at these speeds; caching *forever* is a correctness
   * bug. A host zone really can change under a running process - a laptop crossing a
   * border, an OS setting changed with an SPA still open, `TZ` reassigned in a Node
   * process - and an indefinite cache answered with the old zone silently. Measured
   * against a live `TZ` change, the stale reading was seven hours wrong while `Date` was
   * right, and nothing threw.
   *
   * So the value is re-read when it is more than {@link ZONE_CACHE_MS} old. The check is
   * a clock read the caller has usually already paid for: every other method here needs
   * `Date.now()` anyway and hands it in, so on those paths the freshness check is two
   * comparisons and no syscall.
   *
   * {@link Now.refreshTimeZone} forces it immediately, for a host that can tell you the
   * zone changed rather than making you wait out the window.
   */
  timeZoneId(nowMs: number = Date.now()): string {
    if (systemZone === null || nowMs - systemZoneAt >= ZONE_CACHE_MS || nowMs < systemZoneAt) {
      systemZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
      systemZoneAt = nowMs;
    }
    return systemZone;
  },

  /** Re-read the system zone on the very next call, without waiting out the window. */
  refreshTimeZone(): void {
    systemZone = null;
  },

  /** The current moment. Has no calendar fields - ask a zone for those. */
  instant(): ChronoInstant {
    return new ChronoInstant(unsafeEpochMs(Date.now()));
  },

  /** The current moment as a plain number of epoch milliseconds. */
  epochMilliseconds(): number {
    return Date.now();
  },

  /** The current moment, read through `tz` - the system zone by default. */
  zonedDateTimeISO(tz?: TimeZoneId | string): ChronoZoned {
    const ms = Date.now();
    return new ChronoZoned(unsafeEpochMs(ms), checkedZone(tz ?? Now.timeZoneId(ms)));
  },

  /**
   * The current **clock reading** in `tz`, with no zone attached - what
   * `Temporal.Now.plainDateTimeISO()` returns.
   *
   * At 09:07 local this reads 09:07. It is a {@link ChronoPlain}, so it has no
   * `epochMilliseconds` to mistake for a timestamp.
   */
  plainDateTimeISO(tz?: TimeZoneId | string): ChronoPlain {
    const ms = Date.now();
    const zoneId = checkedZone(tz ?? Now.timeZoneId(ms));
    return new ChronoPlain(unsafeWallMs(ms + offsetAt(zoneId, unsafeEpochMs(ms))));
  },

  /**
   * Today's **local** date in `tz` - a {@link ChronoDate}, matching what
   * `Temporal.Now.plainDateISO()` returns.
   *
   * It returned a `ChronoPlain` pinned to midnight until 1.0.2, which meant
   * `Now.plainDateISO().addHours(5)` compiled and produced a value that was no longer a
   * date. That is precisely the hazard `ChronoDate` exists to remove, so the return type
   * was corrected rather than documented around. For a midnight *reading* rather than a
   * date, `Now.plainDateTimeISO(tz).startOfDay()` still says so explicitly.
   */
  plainDateISO(tz?: TimeZoneId | string): ChronoDate {
    return Now.plainDateTimeISO(tz).toPlainDate();
  },

  /**
   * The current local time of day in `tz`, as minutes since midnight.
   *
   * chronofast has no `PlainTime`, so this is a number - which is what most time-of-day
   * comparisons want. Note it is not monotonic on a spring-forward day, when an hour of
   * local time does not exist.
   */
  minutesSinceMidnight(tz?: TimeZoneId | string): number {
    const p = Now.plainDateTimeISO(tz);
    return p.hour * 60 + p.minute;
  },
} as const;
