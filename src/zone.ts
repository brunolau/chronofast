// chronoFast v2 - IANA timezone engine, TypeScript. No bundled tzdb.
//
// Changes from v1:
//
//   [6] OFFSET STRAIGHT FROM Intl. v1 rebuilt the local wall clock out of
//       formatToParts (about fourteen part objects) and subtracted it from the instant.
//       v2 asks for `timeZoneName: 'longOffset'` and reads "GMT+01:00" off the end of a
//       single formatted string. No part objects, no civil-date conversion.
//       Measured 3.5x faster per uncached lookup, and verified identical across eight
//       zones hourly over two years - including the 45-minute Chatham offset.
//   [7] O(1) RUN MERGING. v1 widened its hot interval by walking up to 128 Map lookups
//       over neighbouring days. v2 stores a shared, mutable run object on every day it
//       covers, so extending a run is one pointer comparison and one field write.
//
// The caching strategy is otherwise unchanged, and so is its one assumption: at most one
// offset transition per UTC day, not reversing within that day. True for every zone in
// the current IANA database. offsetAtUncached() is the assumption-free path.

import type { EpochMs, WallMs, OffsetMs, TimeZoneId } from './brand.js';
import { InvalidInstantError, unsafeEpochMs, unsafeWallMs, unsafeOffsetMs } from './brand.js';
import { MS_SEC, MS_MIN, MS_HOUR, MS_DAY, daysFromCivil, civilFromDays, unpack, daysInMonth,
         pad2, pad3, pad4, year6, isRepresentable,
         cY, cM, cD, cH, cMi, cS, cMs } from './core.js';

interface Run {
  readonly split: false;
  lo: number;
  hi: number;
  readonly off: number;
}
interface Split {
  readonly split: true;
  readonly at: number;      // first instant with the new offset
  readonly lo: number;
  readonly hi: number;
  readonly before: number;
  readonly after: number;
}
type Entry = Run | Split;

const MIN_EPOCH_MS = -8.64e15;
const MAX_EPOCH_MS = 8.64e15;

const resolvedEpochMs = (ms: number): EpochMs => {
  if (!(ms >= MIN_EPOCH_MS && ms <= MAX_EPOCH_MS)) {
    throw new InvalidInstantError(ms);
  }
  return unsafeEpochMs(ms);
};

/**
 * `timeZoneName: 'longOffset'` is ECMA-402 (2021): Chrome 95+, Firefox 91+, Safari 15.4+,
 * Node 18+. Older engines throw RangeError when the option is *constructed*, not when it
 * is read - so this has to be detected up front rather than caught at parse time.
 * Detected once per realm; everything falls back to the slower reconstruct-the-wall-clock
 * path when it is missing.
 */
const LONG_OFFSET_SUPPORTED = /* @__PURE__ */ (() => {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', timeZoneName: 'longOffset' });
    return f.format(0).indexOf('GMT') >= 0;
  } catch {
    return false;
  }
})();

class Zone {
  readonly id: string;
  readonly offFmt: Intl.DateTimeFormat | null;
  readonly days = new Map<number, Entry>();
  hotLo = 1;
  hotHi = 0;
  hotOff = 0;
  intlCalls = 0;

  constructor(id: string) {
    this.id = id;
    this.offFmt = LONG_OFFSET_SUPPORTED
      ? new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'longOffset' })
      : null;
    if (this.offFmt === null) {
      // Validate the zone id anyway, so an unknown zone still fails fast on old engines.
      new Intl.DateTimeFormat('en-US', { timeZone: id });
    }
  }
}

const zones = new Map<string, Zone>();
let lastId: string | null = null;
let lastZone: Zone | null = null;

function zone(tz: TimeZoneId | string): Zone {
  if (tz === lastId) return lastZone!;
  let z = zones.get(tz);
  if (z === undefined) {
    z = new Zone(tz);
    zones.set(tz, z);
  }
  lastId = tz;
  lastZone = z;
  return z;
}

// [6] Read the offset out of a "…, GMT+01:00" tail (optionally with seconds).
// "GMT" alone means zero.
function rawOffset(zc: Zone, utcMs: number): number {
  zc.intlCalls++;
  if (zc.offFmt === null) return offsetFallback(zc, utcMs);
  const str = zc.offFmt.format(utcMs);
  const i = str.lastIndexOf('GMT');
  if (i < 0) return offsetFallback(zc, utcMs);
  const j = i + 3;
  if (j >= str.length) return 0;
  const sign = str.charCodeAt(j);
  if (sign !== 43 && sign !== 45) return 0;

  const d1 = str.charCodeAt(j + 1) - 48;
  const d2 = str.charCodeAt(j + 2) - 48;
  let h: number, k: number;
  if (d2 >>> 0 > 9) { h = d1; k = j + 2; }          // single-digit hour form
  else { h = d1 * 10 + d2; k = j + 3; }
  let m = 0;
  let sec = 0;
  if (str.charCodeAt(k) === 58) {
    m = (str.charCodeAt(k + 1) - 48) * 10 + (str.charCodeAt(k + 2) - 48);
    k += 3;
    // `GMT+00:57:44`. Local Mean Time offsets carry seconds, and ICU emits them - reading
    // only hours and minutes silently truncated Bratislava's 1847 offset from +00:57:44 to
    // +00:57. That is not a curiosity: 338 of the 418 zones this host knows had a
    // sub-minute offset in 1890, and Africa/Monrovia kept one until 1972. Found by the
    // differential suite; the seconds field is simply read when present.
    if (str.charCodeAt(k) === 58) {
      const s1 = str.charCodeAt(k + 1) - 48;
      const s2 = str.charCodeAt(k + 2) - 48;
      if (s1 >>> 0 <= 9 && s2 >>> 0 <= 9) sec = s1 * 10 + s2;
    }
  }
  const off = h * MS_HOUR + m * MS_MIN + sec * MS_SEC;
  return sign === 45 ? -off : off;
}

// Reconstruct-the-wall-clock method, kept for zones or ICU builds whose longOffset
// output we cannot read. Slower, but never wrong.
let fallbackFmt: Map<string, Intl.DateTimeFormat> | null = null;
function offsetFallback(zc: Zone, utcMs: number): number {
  if (fallbackFmt === null) fallbackFmt = new Map();
  let f = fallbackFmt.get(zc.id);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zc.id, hourCycle: 'h23', era: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fallbackFmt.set(zc.id, f);
  }
  const parts = f.formatToParts(utcMs);
  let y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0, bc = false;
  for (const p of parts) {
    const t = p.type;
    if (t === 'year') y = +p.value;
    else if (t === 'month') mo = +p.value;
    else if (t === 'day') d = +p.value;
    else if (t === 'hour') h = +p.value;
    else if (t === 'minute') mi = +p.value;
    else if (t === 'second') s = +p.value;
    else if (t === 'era') bc = p.value.charCodeAt(0) === 66;
  }
  if (bc) y = 1 - y;
  if (h === 24) h = 0;
  const wall = daysFromCivil(y, mo, d) * MS_DAY + h * MS_HOUR + mi * MS_MIN + s * MS_SEC;
  return wall - Math.floor(utcMs / MS_SEC) * MS_SEC;
}

function probeDay(zc: Zone, dayIdx: number): Entry {
  // The final representable instant starts a one-millisecond "day". Keep the cache's
  // half-open interval while never handing Intl a value beyond the ECMAScript time range.
  const dayLo = dayIdx * MS_DAY;
  const lo = dayLo < MIN_EPOCH_MS ? MIN_EPOCH_MS : dayLo;
  const dayHi = dayLo + MS_DAY;
  const hi = dayHi > MAX_EPOCH_MS + 1 ? MAX_EPOCH_MS + 1 : dayHi;
  const o1 = rawOffset(zc, lo);
  const o2 = rawOffset(zc, hi - 1);
  if (o1 === o2) return { split: false, lo, hi, off: o1 };

  let aS = Math.floor(lo / MS_SEC);
  let bS = Math.floor((hi - 1) / MS_SEC);
  while (bS - aS > 1) {
    const midS = aS + ((bS - aS) >> 1);
    if (rawOffset(zc, midS * MS_SEC) === o1) aS = midS; else bS = midS;
  }
  return { split: true, at: bS * MS_SEC, lo, hi, before: o1, after: o2 };
}

function offsetSlow(zc: Zone, t: number): number {
  // The endpoint-day clamp below must not turn an invalid value just outside the range
  // into a cache hit. Keep this check off the hot path while preserving the public
  // formatting contract: out-of-range values throw rather than becoming date-shaped text.
  if (!(t >= MIN_EPOCH_MS && t <= MAX_EPOCH_MS)) throw new RangeError('Invalid time value');
  const dayIdx = Math.floor(t / MS_DAY);
  let e = zc.days.get(dayIdx);

  if (e === undefined) {
    e = probeDay(zc, dayIdx);
    // [7] Merge backwards into the preceding run in O(1). A forward scan - which is
    // what sequential log processing is - grows one run object instead of allocating
    // a new interval per day.
    if (!e.split) {
      const prev = zc.days.get(dayIdx - 1);
      if (prev !== undefined && !prev.split && prev.off === e.off && prev.hi === e.lo) {
        prev.hi = e.hi;
        e = prev;
      }
    }
    zc.days.set(dayIdx, e);
  }

  if (!e.split) {
    zc.hotLo = e.lo; zc.hotHi = e.hi; zc.hotOff = e.off;
    return e.off;
  }
  if (t < e.at) { zc.hotLo = e.lo; zc.hotHi = e.at; zc.hotOff = e.before; return e.before; }
  zc.hotLo = e.at; zc.hotHi = e.hi; zc.hotOff = e.after;
  return e.after;
}

const offsetZ = (zc: Zone, t: number): number =>
  t >= zc.hotLo && t < zc.hotHi ? zc.hotOff : offsetSlow(zc, t);

// ---------------------------------------------------------------- public API

/**
 * UTC offset for `tz` at this instant, in **milliseconds** east of UTC.
 *
 * `7200000` for +02:00, `-18000000` for -05:00. Always a whole number of seconds, and
 * fractional hours are normal: `+05:45` for Kathmandu.
 *
 * Cheap when the instant falls inside an interval already known to have a constant
 * offset, which after any warm-up is nearly always. See {@link zoneStats}.
 */
export function offsetAt(tz: TimeZoneId | string, utcMs: EpochMs): OffsetMs {
  const zc = zone(tz);
  return unsafeOffsetMs(utcMs >= zc.hotLo && utcMs < zc.hotHi ? zc.hotOff : offsetSlow(zc, utcMs));
}

/** Assumption-free reference path. Used by the test suite to validate the cache. */
export const offsetAtUncached = (tz: TimeZoneId | string, utcMs: EpochMs): OffsetMs =>
  unsafeOffsetMs(rawOffset(zone(tz), utcMs));

/**
 * How to resolve a local time that is ambiguous (it happens twice, at a fall-back) or
 * nonexistent (it is skipped, at a spring-forward).
 *
 * - `compatible` - the default, and what Temporal does: the **earlier** of an ambiguous
 *   pair, and shifted **forward** across a gap.
 * - `earlier` / `later` - pick a side explicitly.
 * - `reject` - throw {@link AmbiguousTimeError} rather than choose.
 */
export type Disambiguation = 'compatible' | 'earlier' | 'later' | 'reject';

/** Thrown only under `'reject'` disambiguation, when a local time is ambiguous or does not exist. */
export class AmbiguousTimeError extends RangeError {
  /**
   * @param wall The local wall-clock reading that could not be resolved, as milliseconds.
   * @param tz The zone it was being resolved against.
   */
  constructor(wall: number, tz: string) {
    super(`Local time ${new Date(wall).toISOString().slice(0, 19)} is ambiguous or does not exist in ${tz}`);
    this.name = 'AmbiguousTimeError';
  }
}

/**
 * Resolve a local wall-clock reading to a real instant.
 * Default matches Temporal's `'compatible'`: the earlier of an ambiguous pair, and
 * shifted forward across a spring-forward gap.
 */
export function utcFromWall(
  tz: TimeZoneId | string,
  wallMs: WallMs,
  disambiguation: Disambiguation = 'compatible',
): EpochMs {
  const zc = zone(tz);
  // A shortcut was tried here: when the +-1 day probe window already sits inside the
  // known-constant run, skip both lookups. It was correct but MEASURABLY SLOWER on the
  // zone scenarios (-10% on local midnight, -5% on add-a-local-day). Under scattered
  // access the runs are mostly single days, so the window rarely fits and the extra
  // compares are pure cost. Removed rather than kept on the theory that it should help.
  const beforeProbe = wallMs - MS_DAY < MIN_EPOCH_MS ? MIN_EPOCH_MS : wallMs - MS_DAY;
  const afterProbe = wallMs + MS_DAY > MAX_EPOCH_MS ? MAX_EPOCH_MS : wallMs + MS_DAY;
  const oB = offsetZ(zc, beforeProbe);
  const oA = offsetZ(zc, afterProbe);
  const u1 = wallMs - oB;
  if (oB === oA) return resolvedEpochMs(u1);

  const v1 = offsetZ(zc, u1) === oB;
  const u2 = wallMs - oA;
  const v2 = offsetZ(zc, u2) === oA;

  if (v1 && v2) {
    if (disambiguation === 'reject') throw new AmbiguousTimeError(wallMs, zc.id);
    const earlier = u1 < u2 ? u1 : u2;
    const later = u1 < u2 ? u2 : u1;
    return resolvedEpochMs(disambiguation === 'later' ? later : earlier);
  }
  if (v1) return resolvedEpochMs(u1);
  if (v2) return resolvedEpochMs(u2);
  if (disambiguation === 'reject') throw new AmbiguousTimeError(wallMs, zc.id);
  return resolvedEpochMs(disambiguation === 'earlier' ? wallMs - oA : u1);
}

/** Write local wall-clock fields into the core scratch slots. Zero allocation. */
export function zonedFields(tz: TimeZoneId | string, utcMs: EpochMs): void {
  unpack(utcMs + offsetAt(tz, utcMs));
}

/** Local calendar year in `tz`. */
export const zonedYear = (tz: TimeZoneId | string, ms: EpochMs): number => { zonedFields(tz, ms); return cY; };
/** Local month in `tz`, **1-12**. January is 1. */
export const zonedMonth = (tz: TimeZoneId | string, ms: EpochMs): number => { zonedFields(tz, ms); return cM; };
/** Local day of the month in `tz`, **1-31**. */
export const zonedDay = (tz: TimeZoneId | string, ms: EpochMs): number => { zonedFields(tz, ms); return cD; };
/** Local hour in `tz`, **0-23**. */
export const zonedHour = (tz: TimeZoneId | string, ms: EpochMs): number => { zonedFields(tz, ms); return cH; };

/**
 * The local wall-clock reading, as a {@link WallMs} - a number that looks like an instant
 * but is not one. Feed it to {@link utcFromWall} to get back a real instant; the branded
 * type exists to stop you confusing the two.
 */
export const wallOf = (tz: TimeZoneId | string, utcMs: EpochMs): WallMs =>
  unsafeWallMs(utcMs + offsetAt(tz, utcMs));

/** Local midnight for the day containing `utcMs`. Correct when local midnight does not exist. */
export function startOfDayZoned(tz: TimeZoneId | string, utcMs: EpochMs): EpochMs {
  const wall = utcMs + offsetAt(tz, utcMs);
  const r = wall % MS_DAY;
  return utcFromWall(tz, unsafeWallMs(r < 0 ? wall - r - MS_DAY : wall - r));
}

/** A calendar day in local time: 23 or 25 hours when it crosses a DST boundary. */
export function addDaysZoned(tz: TimeZoneId | string, utcMs: EpochMs, n: number): EpochMs {
  // A zero date duration is exact-time addition in Temporal. Re-resolving the unchanged
  // wall time would collapse the later occurrence of a fold to compatible/earlier.
  if (n === 0) { zone(tz); return utcMs; }
  return utcFromWall(tz, unsafeWallMs(utcMs + offsetAt(tz, utcMs) + n * MS_DAY));
}

/**
 * Add `n` calendar months in local time, keeping the wall-clock time and **clamping to the
 * end of the target month**. The offset is re-resolved afterwards, so a result that crosses
 * a DST boundary is correct.
 */
export function addMonthsZoned(tz: TimeZoneId | string, utcMs: EpochMs, n: number): EpochMs {
  // As above, zero is exact-time addition and must not re-resolve a fold.
  if (n === 0) { zone(tz); return utcMs; }
  const wall = utcMs + offsetAt(tz, utcMs);
  const days = Math.floor(wall / MS_DAY);
  const tod = wall - days * MS_DAY;
  civilFromDays(days);
  const total = cY * 12 + (cM - 1) + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  const dim = daysInMonth(y, m);
  const d = cD > dim ? dim : cD;
  return utcFromWall(tz, unsafeWallMs(daysFromCivil(y, m, d) * MS_DAY + tod));
}

/** Exact-time units are unaffected by DST, so they are plain addition. */
export const addHoursZoned = (_tz: TimeZoneId | string, utcMs: EpochMs, n: number): EpochMs =>
  unsafeEpochMs(utcMs + n * MS_HOUR);


const offStrCache = new Map<number, string>();
function offsetString(off: number): string {
  const hit = offStrCache.get(off);
  if (hit !== undefined) return hit;
  const a = off < 0 ? -off : off;
  const totalSeconds = Math.floor(a / MS_SEC);
  const mins = (totalSeconds / 60) | 0;
  const seconds = totalSeconds % 60;
  let text = (off < 0 ? '-' : '+') + pad2((mins / 60) | 0) + ':' + pad2(mins % 60);
  if (seconds !== 0) text += ':' + pad2(seconds);
  offStrCache.set(off, text);
  return text;
}

// Shared with core rather than reimplemented: the two had drifted, one using padStart and
// one a chain of comparisons.
const year4or6 = (y: number): string => (y >= 0 && y <= 9999 ? pad4(y) : year6(y));

/**
 * Local ISO with offset, e.g. `2024-03-15T11:30:00.123+01:00`.
 *
 * [8] Emitted with a single String.fromCharCode rather than nine concatenations and an
 * offset-string cache lookup. Measured 16% faster.
 */
export function formatZoned(tz: TimeZoneId | string, utcMs: EpochMs): string {
  if (!isRepresentable(utcMs)) throw new RangeError('Invalid time value');
  const off = offsetAt(tz, utcMs);
  const wall = utcMs + off;
  const days = Math.floor(wall / MS_DAY);
  let rem = wall - days * MS_DAY;
  civilFromDays(days);
  const y = cY;
  if (y < 0 || y > 9999 || Math.abs(off) % MS_MIN !== 0) { // rare, keep the readable path
    unpack(wall);
    return year4or6(cY) + '-' + pad2(cM) + '-' + pad2(cD) + 'T' +
           pad2(cH) + ':' + pad2(cMi) + ':' + pad2(cS) + '.' + pad3(cMs) + offsetString(off);
  }
  const h = (rem / MS_HOUR) | 0;   rem -= h * MS_HOUR;
  const mi = (rem / MS_MIN) | 0;   rem -= mi * MS_MIN;
  const sec = (rem / MS_SEC) | 0;  rem -= sec * MS_SEC;
  const a = off < 0 ? -off : off;
  const om = (a / MS_MIN) | 0;
  const oh = (om / 60) | 0, omm = om % 60;
  return String.fromCharCode(
    48 + ((y / 1000) | 0), 48 + (((y / 100) | 0) % 10), 48 + (((y / 10) | 0) % 10), 48 + (y % 10), 45,
    48 + ((cM / 10) | 0), 48 + (cM % 10), 45,
    48 + ((cD / 10) | 0), 48 + (cD % 10), 84,
    48 + ((h / 10) | 0), 48 + (h % 10), 58,
    48 + ((mi / 10) | 0), 48 + (mi % 10), 58,
    48 + ((sec / 10) | 0), 48 + (sec % 10), 46,
    48 + ((rem / 100) | 0), 48 + (((rem / 10) | 0) % 10), 48 + (rem % 10),
    off < 0 ? 45 : 43,
    48 + ((oh / 10) | 0), 48 + (oh % 10), 58,
    48 + ((omm / 10) | 0), 48 + (omm % 10));
}

// Local-day string memo, the zoned twin of core's dayString.
let zDayIdx = Number.NaN;
let zDayTz: string | null = null;
let zDayVal = '';

/** Local `YYYY-MM-DD` - the grouping key for "events per day in the user's zone". */
export function toZonedISODate(tz: TimeZoneId | string, utcMs: EpochMs): string {
  if (!isRepresentable(utcMs)) throw new RangeError('Invalid time value');
  const wallDay = Math.floor((utcMs + offsetAt(tz, utcMs)) / MS_DAY);
  if (wallDay === zDayIdx && tz === zDayTz) return zDayVal;
  civilFromDays(wallDay);
  const y = cY;
  const s = y >= 0 && y <= 9999
    ? String.fromCharCode(
        48 + ((y / 1000) | 0), 48 + (((y / 100) | 0) % 10), 48 + (((y / 10) | 0) % 10), 48 + (y % 10),
        45, 48 + ((cM / 10) | 0), 48 + (cM % 10), 45, 48 + ((cD / 10) | 0), 48 + (cD % 10))
    : year4or6(y) + '-' + pad2(cM) + '-' + pad2(cD);
  zDayIdx = wallDay;
  zDayTz = tz;
  zDayVal = s;
  return s;
}

// ---------------------------------------------------------------- introspection

/** False on engines predating ECMA-402 `longOffset`; the slower fallback is in use. */
export const hasFastOffsetPath = (): boolean => LONG_OFFSET_SUPPORTED;

/** What one zone's cache has done so far. See {@link zoneStats}. */
export interface ZoneStats {
  /**
   * How many times `Intl` has been consulted for this zone since the cache was last reset.
   * Healthy is roughly two per distinct UTC day touched, plus about seventeen more for each
   * day that contains a DST transition, which is binary-searched once and then remembered.
   */
  readonly intlCalls: number;
  /** How many distinct UTC days this zone has an entry for. */
  readonly daysCached: number;
}

/**
 * Cache statistics for one zone, or `null` if it has never been used. Intended for tests
 * and diagnostics: a healthy `intlCalls` is roughly two per distinct UTC day touched, not
 * one per lookup.
 */
export const zoneStats = (tz: TimeZoneId | string): ZoneStats | null => {
  const zc = zones.get(tz);
  return zc ? { intlCalls: zc.intlCalls, daysCached: zc.days.size } : null;
};

/**
 * Drop every cached zone, interval and formatter.
 *
 * Only useful for benchmarking a cold cache, or to release memory after touching a very
 * large number of distinct days. Correctness never depends on calling it.
 */
export function resetZoneCaches(): void {
  zones.clear();
  lastId = null;
  lastZone = null;
  zDayIdx = Number.NaN;
  zDayTz = null;
  zDayVal = '';
  offStrCache.clear();
  if (fallbackFmt !== null) {
    fallbackFmt.clear();
    fallbackFmt = null;
  }
  FMT_CACHE.clear();
}

// ---------------------------------------------------------------- locale formatting
//
// `toLocaleString` on a class with no such method silently resolves to
// `Object.prototype.toLocaleString`, which calls `toString()` and ignores both the locale
// and the options. Nothing throws; every localised date in a UI just renders as an ISO
// string. The methods below exist so that cannot happen.
//
// Constructing an `Intl.DateTimeFormat` per call costs ~46us. Reusing one costs ~1.2us, so
// they are cached on (locale, options, zone). The cache is bounded: a UI uses a handful of
// option shapes, but a caller building option objects in a loop must not be able to grow it
// without limit.

const FMT_CACHE = new Map<string, Intl.DateTimeFormat>();
const FMT_CACHE_MAX = 256;

/** ECMA-402's own defaults, spelled out so a cached formatter matches `Date`'s output. */
const DEFAULT_DATE_TIME: Intl.DateTimeFormatOptions =
  { year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric' };
const DEFAULT_DATE: Intl.DateTimeFormatOptions =
  { year: 'numeric', month: 'numeric', day: 'numeric' };
const DEFAULT_TIME: Intl.DateTimeFormatOptions =
  { hour: 'numeric', minute: 'numeric', second: 'numeric' };
/** `Temporal.ZonedDateTime` names its zone by default; a moment with a zone should say so. */
const DEFAULT_ZONED: Intl.DateTimeFormatOptions =
  { ...DEFAULT_DATE_TIME, timeZoneName: 'short' };

/**
 * Format `ms` through a cached `Intl.DateTimeFormat`.
 *
 * @param tz The zone to render in. Zoneless types pass `'UTC'` and hand in a *wall-clock*
 *   millisecond value, so the reading comes out exactly as written - the same thing
 *   `Temporal.PlainDateTime#toLocaleString` does, including ignoring any `timeZone` the
 *   caller supplied, because a reading with no zone has no moment to shift.
 */
export function formatLocale(
  ms: number,
  tz: string,
  locales: string | string[] | undefined,
  options: Intl.DateTimeFormatOptions | undefined,
  kind: 0 | 1 | 2 | 3,
): string {
  if (!isRepresentable(ms)) return 'Invalid Date';
  const base = kind === 1 ? DEFAULT_DATE : kind === 2 ? DEFAULT_TIME
             : kind === 3 ? DEFAULT_ZONED : DEFAULT_DATE_TIME;
  const hasOwn = options !== undefined && hasDateTimeComponent(options);
  const key = (locales === undefined ? '' : String(locales)) + '\u0000' + tz + '\u0000' +
              String(kind) + '\u0000' + (options === undefined ? '' : JSON.stringify(options));

  let fmt = FMT_CACHE.get(key);
  if (fmt === undefined) {
    // A caller-supplied component list replaces the defaults, exactly as `Intl` does when
    // you pass one; otherwise the defaults fill in.
    const opts: Intl.DateTimeFormatOptions =
      options === undefined ? { ...base } : { ...(hasOwn ? {} : base), ...options };
    opts.timeZone = tz;
    fmt = new Intl.DateTimeFormat(locales, opts);
    if (FMT_CACHE.size >= FMT_CACHE_MAX) FMT_CACHE.clear();
    FMT_CACHE.set(key, fmt);
  }
  return fmt.format(ms);
}

/**
 * Whether the caller named any date or time component, in which case the defaults step
 * aside. This is ECMA-402's own `ToDateTimeOptions` list, and the omissions are deliberate:
 * `timeZoneName` and `era` are *additions* to a format rather than a choice of components,
 * so `{ timeZoneName: 'short' }` still gets the full default date and time beside it -
 * which is what `Date#toLocaleString` does.
 */
function hasDateTimeComponent(o: Intl.DateTimeFormatOptions): boolean {
  return o.dateStyle !== undefined || o.timeStyle !== undefined ||
         o.year !== undefined || o.month !== undefined || o.day !== undefined ||
         o.hour !== undefined || o.minute !== undefined || o.second !== undefined ||
         o.weekday !== undefined || o.dayPeriod !== undefined ||
         o.fractionalSecondDigits !== undefined;
}

/**
 * Whether the caller asked for a time component. A date type uses this to refuse rather
 * than render `00:00` for a time it does not have - which is what `Temporal.PlainDate`
 * does, and what this type exists to prevent.
 */
export function namesATimeComponent(o: Intl.DateTimeFormatOptions | undefined): boolean {
  if (o === undefined) return false;
  return o.timeStyle !== undefined || o.hour !== undefined || o.minute !== undefined ||
         o.second !== undefined || o.dayPeriod !== undefined ||
         o.fractionalSecondDigits !== undefined || o.timeZoneName !== undefined;
}

/** How many formatters are cached. Diagnostics only. */
export const localeFormatterCount = (): number => FMT_CACHE.size;
