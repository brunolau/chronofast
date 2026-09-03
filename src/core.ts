// chronoFast v2 - core UTC engine, TypeScript.
//
// Same shape as v1: an instant is a plain number, conversions are Howard Hinnant's
// integer algorithms, multi-value returns go through module-scoped scratch slots.
//
// What changed in v2, and why:
//
//   [1] CANONICAL FAST PATH in parseISO. The 24-character form
//       "YYYY-MM-DDTHH:MM:SS.sssZ" is what JSON payloads and Date#toISOString actually
//       produce. It is now matched with constant indices and validated with a single
//       branch (seventeen digit tests OR-ed together) instead of sixteen separate
//       branches walked by a moving cursor.
//   [2] CHEAP DAY VALIDATION. daysInMonth() was called on every parse; now only when
//       the day-of-month is above 28, which is roughly one parse in ten.
//   [3] MODULO INSTEAD OF DIV-MUL-SUB for time-of-day field access.
//   [4] CIVIL-DATE MEMO. daysFromCivil() is memoised on a packed y/m/d key. Consecutive
//       timestamps from the same day - the norm in logs and exports - skip the division
//       chain entirely.  (workload-sensitive)
//   [5] DAY-STRING MEMO. The "YYYY-MM-DD" prefix is cached per day index, so formatting
//       a run of same-day timestamps reuses one string.  (workload-sensitive)
//
// [4] and [5] are caches: they win on clustered data and are merely neutral on scattered
// data. They are reported separately from [1]-[3] in the benchmark for that reason.

import type { EpochMs, WallMs, DurationMs, DayIndex } from './brand.js';
import { unsafeEpochMs, unsafeDayIndex } from './brand.js';

/** Milliseconds in a second. */
export const MS_SEC = 1000;
/** Milliseconds in a minute. */
export const MS_MIN = 60_000;
/** Milliseconds in an hour. */
export const MS_HOUR = 3_600_000;
/** Milliseconds in a 24-hour day. A *calendar* day in a zone may be 23 or 25 hours. */
export const MS_DAY = 86_400_000;

// ---------------------------------------------------------------- scratch slots
/**
 * Scratch slots written by {@link unpack} and {@link civilFromDays}, read immediately by
 * the caller. Module-scoped rather than returned in an object so that multi-value results
 * cost no allocation.
 *
 * **Numbering is human, not `Date`-style:**
 * `cM` is 1–12 (January is 1, not 0), `cD` is 1–31, `cH` is 0–23, `cMi` and `cS` are 0–59,
 * `cMs` is 0–999.
 *
 * These are ES module *live bindings*. Read them directly; copying them into an object
 * with spread snapshots the values and they will never update.
 */
export let cY = 0, cM = 0, cD = 0, cH = 0, cMi = 0, cS = 0, cMs = 0;

/**
 * A snapshot of the calendar fields, in the numbering this library uses throughout:
 * month **1-12**, day **1-31**, hour **0-23**, minute and second **0-59**,
 * millisecond **0-999**.
 */
export interface DateTimeFields {
  /** Calendar year. Negative before 1 CE. */
  readonly year: number;
  /** Month, **1-12**. January is 1, not 0. */
  readonly month: number;
  /** Day of the month, **1-31**. */
  readonly day: number;
  /** Hour, **0-23**. */
  readonly hour: number;
  /** Minute, **0-59**. */
  readonly minute: number;
  /** Second, **0-59**. There are no leap seconds. */
  readonly second: number;
  /** Millisecond, **0-999**. The finest precision this library carries. */
  readonly millisecond: number;
}

/** Copy the current scratch slots into an object. Allocates; the slots themselves do not. */
export const readFields = (): DateTimeFields => ({
  year: cY, month: cM, day: cD, hour: cH, minute: cMi, second: cS, millisecond: cMs,
});

// ---------------------------------------------------------------- civil <-> days

/**
 * Days since 1970-01-01 for a proleptic-Gregorian date.
 * @param m Month, **1-12**.
 * @param d Day of month, **1-31**. Not validated.
 */
export function daysFromCivil(y: number, m: number, d: number): number {
  const ya = m <= 2 ? y - 1 : y;
  const era = Math.floor(ya / 400);
  const yoe = ya - era * 400;
  const doy = (((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) | 0) + d - 1;
  const doe = yoe * 365 + ((yoe / 4) | 0) - ((yoe / 100) | 0) + doy;
  return era * 146097 + doe - 719468;
}

// [4] Memo. Key packs y/m/d into one int32; every distinct calendar day gets a distinct
// key, so a hit is always correct rather than merely likely.
let memoYmd = -1;
let memoDays = 0;

function daysFromCivilMemo(y: number, m: number, d: number): number {
  const key = ((y * 16 + m) * 32 + d) | 0;
  if (key === memoYmd) return memoDays;
  const days = daysFromCivil(y, m, d);
  memoYmd = key;
  memoDays = days;
  return days;
}

/** Inverse of {@link daysFromCivil}. Writes {@link cY}, {@link cM}, {@link cD}; returns nothing. */
export function civilFromDays(z: number): void {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = ((doe - ((doe / 1460) | 0) + ((doe / 36524) | 0) - ((doe / 146096) | 0)) / 365) | 0;
  const doy = doe - (365 * yoe + ((yoe / 4) | 0) - ((yoe / 100) | 0));
  const mp = ((5 * doy + 2) / 153) | 0;
  const d = doy - (((153 * mp + 2) / 5) | 0) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  cY = yoe + era * 400 + (m <= 2 ? 1 : 0);
  cM = m;
  cD = d;
}

/** Whole days since 1970-01-01. A cheap integer key for bucketing by UTC day. */
export const dayIndexOf = (ms: EpochMs | WallMs | number): DayIndex =>
  unsafeDayIndex(Math.floor(ms / MS_DAY));

/** Split an instant into all seven scratch slots at once. Zero allocation; returns nothing. */
export function unpack(ms: EpochMs | WallMs | number): void {
  const days = Math.floor(ms / MS_DAY);
  let rem = ms - days * MS_DAY;
  civilFromDays(days);
  cH = (rem / MS_HOUR) | 0;   rem -= cH * MS_HOUR;
  cMi = (rem / MS_MIN) | 0;   rem -= cMi * MS_MIN;
  cS = (rem / MS_SEC) | 0;
  cMs = rem - cS * MS_SEC;
}

/**
 * Build an instant from UTC calendar fields. Not validated and does not clamp.
 * @param m Month, **1-12**.
 */
export const pack = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, msec = 0): EpochMs =>
  unsafeEpochMs(daysFromCivil(y, m, d) * MS_DAY + h * MS_HOUR + mi * MS_MIN + s * MS_SEC + msec);

/**
 * Length of a month in days, leap-aware.
 * @param m Month, **1-12**.
 */
export function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Proleptic-Gregorian leap year: divisible by 4, except centuries not divisible by 400. */
export const isLeapYear = (y: number): boolean =>
  (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// ---------------------------------------------------------------- ISO parsing

const NOT_A_TIME = Number.NaN as EpochMs;

/** The ECMAScript time-value limit. Beyond it a timestamp is not a date, it is a number. */
const MAX_TIME = 8.64e15;
const ISO_DATETIME_LIMIT = MAX_TIME + MS_DAY;
const MIN_DATE_DAY = -100_000_001;
const MAX_DATE_DAY = 100_000_000;

/**
 * Whether `ms` can be serialised as a date at all.
 *
 * The range comparison rejects NaN, both infinities, and values outside the representable
 * range. The integer check enforces this library's documented millisecond precision.
 */
const outOfRange = (ms: number): boolean =>
  !Number.isInteger(ms) || !(ms >= -MAX_TIME && ms <= MAX_TIME);

/** Convert a scanner result into a valid EpochMs or the parser's failure sentinel. */
const parsedEpochMs = (ms: number): EpochMs =>
  outOfRange(ms) ? NOT_A_TIME : unsafeEpochMs(ms);

/** In wall mode syntax is checked here, while the caller applies its type-specific range. */
const parsedScannerValue = (ms: number, keepWall: boolean): EpochMs =>
  keepWall ? unsafeEpochMs(ms) : parsedEpochMs(ms);

/**
 * The offset {@link parseISO} removed from the last string it read, in milliseconds, such
 * that the wall clock as written is `parseISO(s) + parsedOffsetMs`. Zero for `Z` and for
 * strings carrying no designator at all.
 *
 * A module-scoped slot rather than a second return value, for the same reason `cY`/`cM`/`cD`
 * are: it costs no allocation. Only {@link parseISOWall} reads it, immediately.
 */
export let parsedOffsetMs = 0;

/**
 * Parse an ISO-8601 timestamp to epoch milliseconds.
 *
 * Accepts `YYYY-MM-DD`, an optional `T`/space time part, an optional `Z` or numeric
 * designator (`±HH`, `±HHMM`, `±HH:MM`, with optional seconds), and the extended
 * `±YYYYYY` year form. A missing designator reads as UTC.
 * Returns `NaN` (as EpochMs) on malformed input - check with `isValidInstant`.
 */
export function parseISO(s: string): EpochMs {
  const n = s.length;

  // ---- [1] canonical fast path: exactly YYYY-MM-DDTHH:MM:SS.sssZ ----
  if (n === 24 &&
      s.charCodeAt(4) === 45 && s.charCodeAt(7) === 45 && s.charCodeAt(10) === 84 &&
      s.charCodeAt(13) === 58 && s.charCodeAt(16) === 58 && s.charCodeAt(19) === 46 &&
      s.charCodeAt(23) === 90) {
    const a0 = (s.charCodeAt(0) - 48) >>> 0, a1 = (s.charCodeAt(1) - 48) >>> 0;
    const a2 = (s.charCodeAt(2) - 48) >>> 0, a3 = (s.charCodeAt(3) - 48) >>> 0;
    const b0 = (s.charCodeAt(5) - 48) >>> 0, b1 = (s.charCodeAt(6) - 48) >>> 0;
    const c0 = (s.charCodeAt(8) - 48) >>> 0, c1 = (s.charCodeAt(9) - 48) >>> 0;
    const e0 = (s.charCodeAt(11) - 48) >>> 0, e1 = (s.charCodeAt(12) - 48) >>> 0;
    const f0 = (s.charCodeAt(14) - 48) >>> 0, f1 = (s.charCodeAt(15) - 48) >>> 0;
    const g0 = (s.charCodeAt(17) - 48) >>> 0, g1 = (s.charCodeAt(18) - 48) >>> 0;
    const h0 = (s.charCodeAt(20) - 48) >>> 0, h1 = (s.charCodeAt(21) - 48) >>> 0;
    const h2 = (s.charCodeAt(22) - 48) >>> 0;

    // One branch instead of seventeen. The values are unsigned, so a non-digit has
    // already underflowed to a huge number and trips the same test as a digit above 9.
    const bad =
      (a0 > 9 ? 1 : 0) | (a1 > 9 ? 1 : 0) | (a2 > 9 ? 1 : 0) | (a3 > 9 ? 1 : 0) |
      (b0 > 9 ? 1 : 0) | (b1 > 9 ? 1 : 0) | (c0 > 9 ? 1 : 0) | (c1 > 9 ? 1 : 0) |
      (e0 > 9 ? 1 : 0) | (e1 > 9 ? 1 : 0) | (f0 > 9 ? 1 : 0) | (f1 > 9 ? 1 : 0) |
      (g0 > 9 ? 1 : 0) | (g1 > 9 ? 1 : 0) | (h0 > 9 ? 1 : 0) | (h1 > 9 ? 1 : 0) |
      (h2 > 9 ? 1 : 0);
    if (bad !== 0) return NOT_A_TIME;

    const mon = b0 * 10 + b1;
    const day = c0 * 10 + c1;
    const hh = e0 * 10 + e1;
    const mi = f0 * 10 + f1;
    const ss = g0 * 10 + g1;
    // Unsigned compares so that month 0 and day 0 are rejected by the same test.
    if ((mon - 1) >>> 0 > 11 || (day - 1) >>> 0 > 30 || hh > 23 || mi > 59 || ss > 59) {
      return NOT_A_TIME;
    }
    const y = a0 * 1000 + a1 * 100 + a2 * 10 + a3;
    if (day > 28 && day > daysInMonth(y, mon)) return NOT_A_TIME;   // [2]

    // parseISOWall reads this immediately after parseISO. The canonical path used to leave
    // the offset from the preceding general-path parse behind, making a plain value depend
    // on which string happened to be parsed before it.
    parsedOffsetMs = 0;
    return unsafeEpochMs(
      daysFromCivilMemo(y, mon, day) * MS_DAY +                      // [4]
      hh * MS_HOUR + mi * MS_MIN + ss * MS_SEC + (h0 * 100 + h1 * 10 + h2),
    );
  }

  return parseISOGeneral(s, n);
}

function parseISOGeneral(s: string, n: number, keepWall = false): EpochMs {
  if (n < 10) return NOT_A_TIME;

  let i = 0;
  let y = 0;

  const c0 = s.charCodeAt(0);
  if (c0 === 43 || c0 === 45) {
    // An expanded year is a sign plus six digits, so the shortest legal string carrying one
    // is `+YYYYYY-MM-DD` - thirteen characters. The bound was 17, which is the length of an
    // expanded form *with a time*, so `toISODate()` emitted `-111122-05-09` and `parse()`
    // then rejected the library's own output. Found by the differential suite; every field
    // below is digit-checked individually, so a shorter minimum is safe.
    if (n < 13) return NOT_A_TIME;
    let acc = 0;
    for (let k = 1; k < 7; k++) {
      const d = s.charCodeAt(k) - 48;
      if (d >>> 0 > 9) return NOT_A_TIME;
      acc = acc * 10 + d;
    }
    if (c0 === 45 && acc === 0) return NOT_A_TIME;
    y = c0 === 45 ? -acc : acc;
    i = 7;
  } else {
    const a = s.charCodeAt(0) - 48, b = s.charCodeAt(1) - 48;
    const c = s.charCodeAt(2) - 48, d = s.charCodeAt(3) - 48;
    if (a >>> 0 > 9 || b >>> 0 > 9 || c >>> 0 > 9 || d >>> 0 > 9) return NOT_A_TIME;
    y = a * 1000 + b * 100 + c * 10 + d;
    i = 4;
  }

  if (s.charCodeAt(i) !== 45) return NOT_A_TIME;
  const m1 = s.charCodeAt(i + 1) - 48, m2 = s.charCodeAt(i + 2) - 48;
  if (m1 >>> 0 > 9 || m2 >>> 0 > 9) return NOT_A_TIME;
  const mon = m1 * 10 + m2;
  if (mon < 1 || mon > 12) return NOT_A_TIME;
  if (s.charCodeAt(i + 3) !== 45) return NOT_A_TIME;
  const d1 = s.charCodeAt(i + 4) - 48, d2 = s.charCodeAt(i + 5) - 48;
  if (d1 >>> 0 > 9 || d2 >>> 0 > 9) return NOT_A_TIME;
  const day = d1 * 10 + d2;
  if (day < 1 || day > 31) return NOT_A_TIME;
  if (day > 28 && day > daysInMonth(y, mon)) return NOT_A_TIME;      // [2]
  i += 6;

  let h = 0, mi = 0, sec = 0, frac = 0;

  if (i < n) {
    const sep = s.charCodeAt(i);
    if (sep === 84 || sep === 116 || sep === 32) {
      i++;
      const h1 = s.charCodeAt(i) - 48, h2 = s.charCodeAt(i + 1) - 48;
      if (h1 >>> 0 > 9 || h2 >>> 0 > 9) return NOT_A_TIME;
      h = h1 * 10 + h2;
      if (h > 23) return NOT_A_TIME;
      if (s.charCodeAt(i + 2) !== 58) return NOT_A_TIME;
      const n1 = s.charCodeAt(i + 3) - 48, n2 = s.charCodeAt(i + 4) - 48;
      if (n1 >>> 0 > 9 || n2 >>> 0 > 9) return NOT_A_TIME;
      mi = n1 * 10 + n2;
      if (mi > 59) return NOT_A_TIME;
      i += 5;

      if (s.charCodeAt(i) === 58) {
        const s1 = s.charCodeAt(i + 1) - 48, s2 = s.charCodeAt(i + 2) - 48;
        if (s1 >>> 0 > 9 || s2 >>> 0 > 9) return NOT_A_TIME;
        sec = s1 * 10 + s2;
        if (sec > 59) return NOT_A_TIME;
        i += 3;

        const dot = s.charCodeAt(i);
        if (dot === 46 || dot === 44) {
          i++;
          let k = 0;
          let scale = 100;
          while (i < n) {
            const d = s.charCodeAt(i) - 48;
            if (d >>> 0 > 9) break;
            if (k < 3) frac += d * scale;
            scale = (scale / 10) | 0;
            k++;
            i++;
          }
          if (k === 0) return NOT_A_TIME;
        }
      }
    }
  }

  const base = daysFromCivilMemo(y, mon, day) * MS_DAY +
               h * MS_HOUR + mi * MS_MIN + sec * MS_SEC + frac;

  parsedOffsetMs = 0;
  if (i >= n) return parsedScannerValue(base, keepWall);

  const z = s.charCodeAt(i);
  if (z === 90 || z === 122) {
    return i + 1 === n ? parsedScannerValue(base, keepWall) : NOT_A_TIME;
  }
  if (z !== 43 && z !== 45) return NOT_A_TIME;

  const oh1 = s.charCodeAt(i + 1) - 48, oh2 = s.charCodeAt(i + 2) - 48;
  if (oh1 >>> 0 > 9 || oh2 >>> 0 > 9) return NOT_A_TIME;
  const oh = oh1 * 10 + oh2;
  if (oh > 23) return NOT_A_TIME;
  i += 3;

  let om = 0, os = 0;
  if (i < n) {
    const colonForm = s.charCodeAt(i) === 58;
    if (colonForm) i++;
    const om1 = s.charCodeAt(i) - 48, om2 = s.charCodeAt(i + 1) - 48;
    if (om1 >>> 0 > 9 || om2 >>> 0 > 9) return NOT_A_TIME;
    om = om1 * 10 + om2;
    if (om > 59) return NOT_A_TIME;
    i += 2;
    if (i < n) {
      // ISO permits historical offsets with seconds. Keep colon and compact forms
      // internally consistent: +00:44:30 / +004430, never a mixed spelling.
      if (colonForm) {
        if (s.charCodeAt(i) !== 58) return NOT_A_TIME;
        i++;
      }
      const os1 = s.charCodeAt(i) - 48, os2 = s.charCodeAt(i + 1) - 48;
      if (os1 >>> 0 > 9 || os2 >>> 0 > 9) return NOT_A_TIME;
      os = os1 * 10 + os2;
      if (os > 59) return NOT_A_TIME;
      i += 2;
    }
    if (i !== n) return NOT_A_TIME;
  }

  const off = oh * MS_HOUR + om * MS_MIN + os * MS_SEC;
  parsedOffsetMs = z === 45 ? -off : off;
  return parsedScannerValue(keepWall ? base : z === 45 ? base + off : base - off, keepWall);
}

/**
 * Parse an ISO-8601 string as a **wall-clock reading**, keeping the local time exactly as
 * written and discarding any offset.
 *
 * `'2024-03-15T23:30:00-05:00'` reads as `2024-03-15T23:30`, not as the UTC instant that
 * moment corresponds to. That is what `Temporal.PlainDateTime.from` does, and it is the
 * only sensible answer for a type with no zone: the string says the clock on the wall read
 * 23:30, and shifting it to 04:30 the next day silently changes the time and the date both.
 */
const parseISOWallValue = (s: string): number => {
  const ms = parseISO(s);
  // A representable wall clock at either range boundary can name an instant outside that
  // range once its offset is applied. Retry the general scanner in wall mode so an offset
  // that this API deliberately discards cannot make an otherwise-valid reading fail.
  return ms !== ms ? parseISOGeneral(s, s.length, true) : ms + parsedOffsetMs;
};

export function parseISOWall(s: string): WallMs {
  const wall = parseISOWallValue(s);
  return (outOfRange(wall) ? NOT_A_TIME : wall) as unknown as WallMs;
}

/**
 * Parse a wall clock that will immediately be resolved through a time zone. Temporal gives
 * this intermediate representation one day of padding on either side of the instant range,
 * so every boundary instant can be reached through every possible zone offset. The bounds
 * are open; the final resolved instant still has to pass the ordinary ±8.64e15 ms check.
 */
export function parseISOZonedWall(s: string): number {
  const wall = parseISOWallValue(s);
  return Number.isInteger(wall) && wall > -ISO_DATETIME_LIMIT && wall < ISO_DATETIME_LIMIT
    ? wall
    : NOT_A_TIME;
}

/**
 * Parse a complete ISO string and return its written calendar day, discarding time and
 * offset. A date has a slightly wider lower bound than an ECMAScript instant, so it must
 * not be range-checked through {@link parseISOWall} first.
 */
export function parseISODate(s: string): DayIndex {
  const wall = parseISOWallValue(s);
  const day = Math.floor(wall / MS_DAY);
  return (day >= MIN_DATE_DAY && day <= MAX_DATE_DAY)
    ? unsafeDayIndex(day)
    : NOT_A_TIME as unknown as DayIndex;
}

/**
 * Whether the string ends in a `Z` specifically, rather than any designator.
 *
 * `Temporal.PlainDate.from` accepts `'2024-03-15T10:30+01:00'` but rejects
 * `'2024-03-15T10:30Z'`, and the distinction is deliberate: an offset still describes a
 * local wall clock, so the date as written is the date meant. A `Z` describes UTC and
 * nothing else, so which calendar day it lands on depends on a zone the string does not
 * carry. {@link ChronoDate.parse} follows the same rule.
 */
export function hasUtcDesignator(s: string): boolean {
  for (let k = s.length - 1; k >= 8; k--) {
    const c = s.charCodeAt(k);
    if (c === 90 || c === 122) return true;                      // 'Z' | 'z'
    if (c >= 48 && c <= 57) return false;                        // a digit ends it
  }
  return false;
}

/**
 * Did this string carry a zone designator - a trailing `Z` or numeric offset?
 *
 * The distinction decides meaning, not just formatting: `2000-09-01T10:00Z` names an exact
 * instant, whereas `2000-09-01T10:00` names a wall-clock reading that is only an instant
 * once you say which zone it was read in. Scanning starts after the date so the hyphens in
 * `YYYY-MM-DD`, and the sign of an expanded year, are never mistaken for an offset.
 */
export function hasZoneDesignator(s: string): boolean {
  // Start after the complete date, including a signed expanded year. This also recognizes
  // a designator on the date-only spellings accepted by parseISO; previously those strings
  // parsed as instants but ChronoZoned silently reinterpreted them as local midnight.
  const start = s.charCodeAt(0) === 43 || s.charCodeAt(0) === 45 ? 13 : 10;
  for (let k = start; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 90 || c === 122 || c === 43 || c === 45) return true;   // 'Z' | 'z' | '+' | '-'
  }
  return false;
}

// ---------------------------------------------------------------- ISO formatting

// Two-digit and three-digit padding.
//
// These used to be 100- and 1000-entry lookup tables built at module load. Since the
// emitters were rewritten to produce their whole result with one String.fromCharCode call,
// nothing on a hot path reads them any more - only the rare expanded-year fallbacks do.
// Building 1,100 strings at import for a path that almost never runs was pure startup
// cost, so they are plain functions now.
/** Zero-pad to two digits. */
export const pad2 = (n: number): string => (n < 10 ? '0' + n : '' + n);
/** Zero-pad to three digits. */
export const pad3 = (n: number): string => (n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n);
/** Zero-pad to four digits. */
/**
 * Four-digit zero pad. **Only valid for 0..9999.**
 *
 * A negative input pads in front of the minus sign - `pad4(-1)` is `'000-1'` - so any
 * caller formatting a year must route years outside that range through {@link year6},
 * which emits the ISO expanded form (`-110091`, `+010000`). A differential run against
 * Temporal caught `toPlainISOString` doing exactly this for pre-epoch expanded years.
 */
export const pad4 = (n: number): string =>
  n < 10 ? '000' + n : n < 100 ? '00' + n : n < 1000 ? '0' + n : '' + n;

/** Expanded-year form for years outside 0000-9999, e.g. `+010000` or `-000001`. */
export function year6(y: number): string {
  const a = y < 0 ? -y : y;
  const p = a < 10 ? '00000' : a < 100 ? '0000' : a < 1000 ? '000'
          : a < 10000 ? '00' : a < 100000 ? '0' : '';
  return (y < 0 ? '-' : '+') + p + a;
}

// [5] Day-string memo. A run of timestamps from one day reuses a single prefix string.
let dayStrIdx = Number.NaN;
let dayStrVal = '';

function dayString(dayIdx: number): string {
  if (dayIdx === dayStrIdx) return dayStrVal;
  civilFromDays(dayIdx);
  const y = cY;
  const s = y >= 0 && y <= 9999
    ? String.fromCharCode(
        48 + ((y / 1000) | 0), 48 + (((y / 100) | 0) % 10), 48 + (((y / 10) | 0) % 10), 48 + (y % 10),
        45, 48 + ((cM / 10) | 0), 48 + (cM % 10), 45, 48 + ((cD / 10) | 0), 48 + (cD % 10))
    : year6(y) + '-' + pad2(cM) + '-' + pad2(cD);
  dayStrIdx = dayIdx;
  dayStrVal = s;
  return s;
}

// [8] Emit the whole 24-character result with ONE String.fromCharCode call rather than a
// chain of concatenations. Measured 31% faster on scattered input. It is ~10% slower than
// a cached prefix when every timestamp lands on the same day, because the string memo can
// skip construction entirely - but the scattered win is three times the clustered loss, so
// this is the better default. Caching the decomposed y/m/d instead was tried and refuted:
// civilFromDays is already cheap, and the cache check cost more than it saved.
function isoExtendedYear(rem: number): string {
  const ys = year6(cY);
  const h = (rem / MS_HOUR) | 0;  rem -= h * MS_HOUR;
  const mi = (rem / MS_MIN) | 0;  rem -= mi * MS_MIN;
  const s = (rem / MS_SEC) | 0;
  return ys + '-' + pad2(cM) + '-' + pad2(cD) + 'T' +
         pad2(h) + ':' + pad2(mi) + ':' + pad2(s) + '.' + pad3(rem - s * MS_SEC) + 'Z';
}

/**
 * Byte-for-byte equal to `Date.prototype.toISOString()`, **including on invalid input**:
 * both throw `RangeError: Invalid time value` rather than returning a string.
 *
 * The guard is not decorative. Without it a `NaN` instant reaches the `String.fromCharCode`
 * call below with `NaN` in every digit slot, and `String.fromCharCode(NaN)` is `U+0000` -
 * so an invalid value used to serialise to `"000\u0000-03-0\u0000T00:00:00.00\u0000Z"`.
 * That looks enough like a timestamp to travel: into JSON, then into a database, where
 * Postgres rejects NUL in `text` and `jsonb` far away from the parse that caused it.
 * Failing here, loudly, is the whole point.
 */
export function toISO(ms: EpochMs): string {
  if (outOfRange(ms)) throw new RangeError('Invalid time value');
  const days = Math.floor(ms / MS_DAY);
  let rem = ms - days * MS_DAY;
  civilFromDays(days);
  const y = cY;
  if (y < 0 || y > 9999) return isoExtendedYear(rem);   // rare, keep the slow path
  const h = (rem / MS_HOUR) | 0;  rem -= h * MS_HOUR;
  const mi = (rem / MS_MIN) | 0;  rem -= mi * MS_MIN;
  const sec = (rem / MS_SEC) | 0; rem -= sec * MS_SEC;
  return String.fromCharCode(
    48 + ((y / 1000) | 0), 48 + (((y / 100) | 0) % 10), 48 + (((y / 10) | 0) % 10), 48 + (y % 10), 45,
    48 + ((cM / 10) | 0), 48 + (cM % 10), 45,
    48 + ((cD / 10) | 0), 48 + (cD % 10), 84,
    48 + ((h / 10) | 0), 48 + (h % 10), 58,
    48 + ((mi / 10) | 0), 48 + (mi % 10), 58,
    48 + ((sec / 10) | 0), 48 + (sec % 10), 46,
    48 + ((rem / 100) | 0), 48 + (((rem / 10) | 0) % 10), 48 + (rem % 10), 90);
}

/**
 * `YYYY-MM-DD` in UTC - the grouping key for daily aggregation.
 * Here the memo IS kept: the entire result depends only on the day, so a hit returns a
 * cached string and does no work at all (9ns against 47ns). Misses now emit through
 * fromCharCode too, which is 11% faster than the old concatenation.
 */
/**
 * `YYYY-MM-DD` straight from a **day index** (days since 1970-01-01), skipping the divide
 * that {@link toISODate} needs to recover one. This is the hot path for `ChronoDate`, which
 * stores a day index rather than a timestamp, and it shares the same day-string memo.
 */
export const isoDateOfDay = (dayIdx: DayIndex | number): string => {
  if (!Number.isInteger(dayIdx) || dayIdx < MIN_DATE_DAY || dayIdx > MAX_DATE_DAY) {
    throw new RangeError('Invalid time value');
  }
  return dayString(dayIdx);
};

export const toISODate = (ms: EpochMs): string => {
  if (outOfRange(ms)) throw new RangeError('Invalid time value');
  return dayString(Math.floor(ms / MS_DAY));
};

// ---------------------------------------------------------------- day-index calendar
//
// `ChronoDate` stores a day index - days since 1970-01-01 - rather than a timestamp. That
// is not a cosmetic difference. A wall-clock midnight in 2024 is ~1.7e12, past the Smi
// range, so V8 boxes it; a day index is ~19,800 and stays an immediate. Every function
// below therefore avoids the `Math.floor(ms / MS_DAY)` divide that the ms-based twins need
// just to recover the day. Measured against the ms route: daysUntil 2.3ns -> 1.1ns,
// field read 16.4ns -> 12.2ns, YYYY-MM-DD 40ns -> 34ns, sorting 2000 dates 77us -> 66us.

/** ISO day of week from a day index, **1-7** (Monday is 1). 1970-01-01 was a Thursday. */
export function dayOfWeekOfDay(dayIdx: number): number {
  const w = (dayIdx + 3) % 7;
  return (w < 0 ? w + 7 : w) + 1;
}

/** Day of the year from a day index, **1-366**. */
export function dayOfYearOfDay(dayIdx: number): number {
  civilFromDays(dayIdx);
  return dayIdx - jan1Of(cY) + 1;
}

/** First day of the ISO week containing `dayIdx`, honouring `firstDay` (1 = Monday). */
export function startOfWeekOfDay(dayIdx: number, firstDay = 1): number {
  const w = dayOfWeekOfDay(dayIdx) - firstDay;
  return dayIdx - (w < 0 ? w + 7 : w);
}

/** ISO-8601 week number from a day index, **1-53**. */
export function isoWeekOfDay(dayIdx: number): number {
  const thursday = dayIdx - (dayOfWeekOfDay(dayIdx) - 1) + 3;
  civilFromDays(thursday);
  return (((thursday - jan1Of(cY)) / 7) | 0) + 1;
}

/** The year that owns the ISO week containing `dayIdx`, which can differ from the year. */
export function isoWeekYearOfDay(dayIdx: number): number {
  civilFromDays(dayIdx - (dayOfWeekOfDay(dayIdx) - 1) + 3);
  return cY;
}

/** First day of the month containing `dayIdx`. */
export function startOfMonthOfDay(dayIdx: number): number {
  civilFromDays(dayIdx);
  return dayIdx - cD + 1;
}

/** First day of the year containing `dayIdx`. */
export function startOfYearOfDay(dayIdx: number): number {
  civilFromDays(dayIdx);
  return jan1Of(cY);
}

/** Last day of the month containing `dayIdx`. */
export function endOfMonthOfDay(dayIdx: number): number {
  civilFromDays(dayIdx);
  return dayIdx - cD + daysInMonth(cY, cM);
}

/**
 * Add `n` calendar months to a day index, **clamping to the end of the target month** so
 * 31 Jan + 1 month is 28/29 Feb rather than spilling into March. Same rule as
 * {@link addMonths}, but without the timestamp round trip.
 */
export function addMonthsOfDay(dayIdx: number, n: number): number {
  civilFromDays(dayIdx);
  const total = cY * 12 + (cM - 1) + n;
  let m0 = total % 12;
  if (m0 < 0) m0 += 12;
  const y = (total - m0) / 12;
  const dim = m0 === 1
    ? (((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28)
    : 30 + ((MONTH_LEN_BITS >> m0) & 1);
  return daysFromCivil(y, m0 + 1, cD > dim ? dim : cD);
}

/** Whole calendar months between two day indices, truncated toward zero. */
export function diffMonthsOfDay(a: number, b: number): number {
  civilFromDays(a);
  const ay = cY, am = cM, ad = cD;
  civilFromDays(b);
  let months = (cY - ay) * 12 + (cM - am);
  if (months > 0 && cD < ad) months--;
  else if (months < 0 && cD > ad) months++;
  return months;
}

// ---------------------------------------------------------------- field access

/** Calendar year in UTC. Negative for years before 1 CE. */
export const getYear = (ms: EpochMs): number => { civilFromDays(Math.floor(ms / MS_DAY)); return cY; };
/** Calendar month in UTC, **1–12** — January is 1, not 0. */
export const getMonth = (ms: EpochMs): number => { civilFromDays(Math.floor(ms / MS_DAY)); return cM; };
/** Day of the month in UTC, **1–31**. */
export const getDay = (ms: EpochMs): number => { civilFromDays(Math.floor(ms / MS_DAY)); return cD; };

// [3] modulo, rather than floor-multiply-subtract
/** Hour in UTC, **0-23**. */
export function getHour(ms: EpochMs): number {
  const r = ms % MS_DAY;
  return (((r < 0 ? r + MS_DAY : r) / MS_HOUR) | 0);
}
/** Minute in UTC, **0-59**. */
export function getMinute(ms: EpochMs): number {
  const r = ms % MS_HOUR;
  return (((r < 0 ? r + MS_HOUR : r) / MS_MIN) | 0);
}
/** Second in UTC, **0-59**. No leap seconds. */
export function getSecond(ms: EpochMs): number {
  const r = ms % MS_MIN;
  return (((r < 0 ? r + MS_MIN : r) / MS_SEC) | 0);
}
/** Millisecond in UTC, **0-999**. */
export function getMillisecond(ms: EpochMs): number {
  const r = ms % MS_SEC;
  // `| 0` also normalises -0 to 0: a negative instant landing exactly on a second boundary
  // otherwise returns -0, which compares equal to 0 but is distinguishable via Object.is.
  return (r < 0 ? r + MS_SEC : r) | 0;
}

/**
 * ISO day of week: **1 = Monday … 7 = Sunday**.
 *
 * This is the ISO-8601 convention, and the same numbering `ChronoInstant#dayOfWeek` and
 * `Temporal.PlainDate#dayOfWeek` use. If you want `Date`'s 0-based, Sunday-first numbering,
 * call {@link dayOfWeekSunday0} — it is named explicitly because a function called
 * `dayOfWeek` returning two different conventions in two places is how bugs happen.
 *
 * @returns 1–7, Monday through Sunday.
 */
export function dayOfWeek(ms: EpochMs): number {
  const w = (Math.floor(ms / MS_DAY) + 3) % 7;
  return (w < 0 ? w + 7 : w) + 1;
}

/**
 * `Date`-compatible day of week: **0 = Sunday … 6 = Saturday**.
 *
 * Identical to `Date.prototype.getUTCDay()`. Use this only when you are interoperating
 * with code that already expects that numbering; {@link dayOfWeek} is the ISO one.
 *
 * @returns 0–6, Sunday through Saturday.
 */
export function dayOfWeekSunday0(ms: EpochMs): number {
  const w = (Math.floor(ms / MS_DAY) + 4) % 7;
  return (w < 0 ? w + 7 : w) | 0;      // `| 0` normalises -0 to 0
}

// [9] The week number needs the day index of Jan 1 of the ISO week-year. That was a second
// full civil conversion per call; years are few, so a small table serves instead.
const JAN1_LO = 1700, JAN1_N = 600;
const jan1Days = new Int32Array(JAN1_N);
const jan1Known = new Uint8Array(JAN1_N);

function jan1Of(y: number): number {
  const i = y - JAN1_LO;
  if (i >>> 0 >= JAN1_N) return daysFromCivil(y, 1, 1);
  if (jan1Known[i] === 1) return jan1Days[i]!;
  const d = daysFromCivil(y, 1, 1);
  jan1Days[i] = d;
  jan1Known[i] = 1;
  return d;
}

/** ISO-8601 week number, **1-53**. Week 1 holds the first Thursday. See {@link isoWeekYear}. */
export function isoWeek(ms: EpochMs): number {
  const days = Math.floor(ms / MS_DAY);
  const dowMon = (((days + 3) % 7) + 7) % 7;
  const thursday = days - dowMon + 3;
  civilFromDays(thursday);
  return (((thursday - jan1Of(cY)) / 7) | 0) + 1;
}

/** ISO week-numbering year, which can differ from the calendar year at a year boundary. */
export function isoWeekYear(ms: EpochMs): number {
  const days = Math.floor(ms / MS_DAY);
  const dowMon = (((days + 3) % 7) + 7) % 7;
  civilFromDays(days - dowMon + 3);
  return cY;
}

/** Day of the year, **1-366**. 1 January is 1. */
export function dayOfYear(ms: EpochMs): number {
  const days = Math.floor(ms / MS_DAY);
  civilFromDays(days);
  return days - daysFromCivil(cY, 1, 1) + 1;
}

// ---------------------------------------------------------------- arithmetic (UTC)

/** Exact-time addition. Every `add*` helper here accepts a negative `n`. */
export const addMilliseconds = (ms: EpochMs, n: DurationMs | number): EpochMs => unsafeEpochMs(ms + n);
/** Add `n` seconds of elapsed time. */
export const addSeconds = (ms: EpochMs, n: number): EpochMs => unsafeEpochMs(ms + n * MS_SEC);
/** Add `n` minutes of elapsed time. */
export const addMinutes = (ms: EpochMs, n: number): EpochMs => unsafeEpochMs(ms + n * MS_MIN);
/** Add `n` hours of elapsed time. */
export const addHours = (ms: EpochMs, n: number): EpochMs => unsafeEpochMs(ms + n * MS_HOUR);
/** Add `n` days of exactly 24 hours. On the UTC timeline that is also a calendar day. */
export const addDays = (ms: EpochMs, n: number): EpochMs => unsafeEpochMs(ms + n * MS_DAY);
/** Add `n * 7` days. */
export const addWeeks = (ms: EpochMs, n: number): EpochMs => unsafeEpochMs(ms + n * 7 * MS_DAY);

// [10] Month length inside addMonths does not go through daysInMonth (a call plus a chain
// of comparisons) and no longer goes through a 12-entry array either: a 12-bit mask needs
// no bounds check. February is special-cased, so its bit is never consulted.
/** Bit `i` set means month `i` (0-based) has 31 days. February is always special-cased. */
const MONTH_LEN_BITS = 0b1010_1101_0101;

/**
 * Calendar month arithmetic, **clamping to the end of the target month** so the result
 * never lands in the following one.
 *
 * @example
 * addMonths(parseISO('2024-01-31T00:00:00Z'), 1)   // 2024-02-29
 * addMonths(parseISO('2023-01-31T00:00:00Z'), 1)   // 2023-02-28
 */
export function addMonths(ms: EpochMs, n: number): EpochMs {
  const days = Math.floor(ms / MS_DAY);
  const tod = ms - days * MS_DAY;
  civilFromDays(days);
  const total = cY * 12 + (cM - 1) + n;
  // `total % 12` with a sign fix costs less than `Math.floor(total / 12)`, and once the
  // month is known the year falls out by exact division. Month length then comes from a
  // 12-bit mask (set bit = 31 days) rather than an array load, which skips a bounds check.
  // Measured together: 29.0ns -> 26.4ns, verified against the old form on 300k cases.
  let m0 = total % 12;                                // 0-11 after the sign fix
  if (m0 < 0) m0 += 12;
  const y = (total - m0) / 12;
  const dim = m0 === 1
    ? (((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28)
    : 30 + ((MONTH_LEN_BITS >> m0) & 1);
  const d = cD > dim ? dim : cD;
  return unsafeEpochMs(daysFromCivil(y, m0 + 1, d) * MS_DAY + tod);
}

/** Add `n * 12` months, clamping. 29 February plus one year is 28 February. */
export const addYears = (ms: EpochMs, n: number): EpochMs => addMonths(ms, n * 12);

// ---------------------------------------------------------------- truncation (UTC)

/** Midnight **UTC**. For local midnight see `startOfDayZoned` in `chronofast/zone`. */
export function startOfDay(ms: EpochMs): EpochMs {
  const r = ms % MS_DAY;
  return unsafeEpochMs(r < 0 ? ms - r - MS_DAY : ms - r);
}
/** Top of this UTC hour. */
export function startOfHour(ms: EpochMs): EpochMs {
  const r = ms % MS_HOUR;
  return unsafeEpochMs(r < 0 ? ms - r - MS_HOUR : ms - r);
}
/** Start of this UTC minute. */
export function startOfMinute(ms: EpochMs): EpochMs {
  const r = ms % MS_MIN;
  return unsafeEpochMs(r < 0 ? ms - r - MS_MIN : ms - r);
}
/** Midnight UTC on the first day of this month. */
export function startOfMonth(ms: EpochMs): EpochMs {
  civilFromDays(Math.floor(ms / MS_DAY));
  return unsafeEpochMs(daysFromCivil(cY, cM, 1) * MS_DAY);
}
/** Midnight UTC on 1 January of this year. */
export function startOfYear(ms: EpochMs): EpochMs {
  civilFromDays(Math.floor(ms / MS_DAY));
  return unsafeEpochMs(daysFromCivil(cY, 1, 1) * MS_DAY);
}
/**
 * Midnight UTC on the first day of this week.
 * @param firstDay `0` = Sunday ... `6` = Saturday. Defaults to `1`, Monday (ISO).
 */
export function startOfWeek(ms: EpochMs, firstDay = 1): EpochMs {
  const days = Math.floor(ms / MS_DAY);
  const dow = (((days + 4) % 7) + 7) % 7;
  const delta = (((dow - firstDay) % 7) + 7) % 7;
  return unsafeEpochMs((days - delta) * MS_DAY);
}

// ---------------------------------------------------------------- differences

/** Elapsed milliseconds from `a` to `b`. Negative if `b` is earlier. */
export const diffMilliseconds = (a: EpochMs, b: EpochMs): number => b - a;
/** Whole **calendar** days from `a` to `b`, not 24-hour spans: 23:59 to 00:01 is 1. */
export const diffDays = (a: EpochMs, b: EpochMs): number =>
  Math.floor(b / MS_DAY) - Math.floor(a / MS_DAY);

/** Whole calendar months from a to b, truncated toward zero. */
export function diffMonths(a: EpochMs, b: EpochMs): number {
  civilFromDays(Math.floor(a / MS_DAY)); const ay = cY, am = cM, ad = cD;
  civilFromDays(Math.floor(b / MS_DAY)); const by = cY, bm = cM, bd = cD;
  let d = (by - ay) * 12 + (bm - am);
  if (d > 0 && bd < ad) d--;
  else if (d < 0 && bd > ad) d++;
  return d;
}

/** Whole calendar years from `a` to `b`, truncated toward zero. */
export const diffYears = (a: EpochMs, b: EpochMs): number => (diffMonths(a, b) / 12) | 0;

// ---------------------------------------------------------------- comparison

/** Comparator for `Array#sort`, earliest first. */
export const compare = (a: EpochMs, b: EpochMs): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);
/** `a` is strictly earlier than `b`. */
export const isBefore = (a: EpochMs, b: EpochMs): boolean => a < b;
/** `a` is strictly later than `b`. */
export const isAfter = (a: EpochMs, b: EpochMs): boolean => a > b;
/** The earlier of two instants. */
export const min = (a: EpochMs, b: EpochMs): EpochMs => (a < b ? a : b);
/** The later of two instants. */
export const max = (a: EpochMs, b: EpochMs): EpochMs => (a > b ? a : b);

/** Reset the internal memos. Only useful for benchmarking a cold cache. */
export function resetMemos(): void {
  memoYmd = -1;
  memoDays = 0;
  dayStrIdx = Number.NaN;
  dayStrVal = '';
}

/**
 * Whether a millisecond value can be a date: integral, finite, and inside the ECMAScript
 * time range.
 * `isValid` on every class routes through this, so `Infinity` reports invalid rather than
 * claiming to be a date and then serialising as one.
 */
export const isRepresentable = (ms: number): boolean => !outOfRange(ms);
