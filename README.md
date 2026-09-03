# chronofast

Performance-oriented, fully typed date library for JavaScript and TypeScript.
Real IANA time zones **without bundling a tzdb**. Zero dependencies.

```bash
npm install chronofast
```

```ts
import { ChronoInstant } from 'chronofast';

const t = ChronoInstant.parse('2024-03-15T10:30:00.000Z');

t.addDays(7).toISOString()               // '2024-03-22T10:30:00.000Z'
t.epochMilliseconds                      // 1710498600000

// A moment has no calendar fields - ask which clock you mean first.
t.toUtcPlain().year                      // 2024  (UTC)

const z = t.inZone('Europe/Bratislava');
z.hour                                   // 11  (local)
z.toISOString()                          // '2024-03-15T11:30:00.000+01:00'
z.addDays(1).toISOString()               // a calendar day, not 24 hours
```

> **Coming from `Temporal`?** Read
> [MIGRATING-FROM-TEMPORAL.md](./MIGRATING-FROM-TEMPORAL.md) first. `ChronoPlain` covers
> `PlainDateTime` and `PlainDate`; there is no `PlainTime` and no `Duration`, and several of
> the differences are silent rather than loud — a mechanical replace produces code that
> compiles and is wrong.

## Why another date library

Most libraries pick one of three deals on time zones: skip them (fast, but you write the
DST bugs yourself), bundle the IANA database (correct, but hundreds of kilobytes), or call
`Intl` on every lookup (correct, small, and slow — microseconds per operation).

chronofast takes a fourth: derive offsets from `Intl`, then **cache the intervals over
which each offset is constant**, so `Intl` is consulted about twice per distinct UTC day
rather than once per timestamp.

> 50,000 offset lookups across 35 days cost **70** `Intl` calls — a 714× reduction,
> 99.86% hit rate. Reproduce it with `npm test`.

That is the whole trick. It is a technique, not magic, and the benchmark says so out loud.

## Performance

**Nanoseconds per operation, lower is better.** Median of three runs, and **every measurement
runs in its own process** — see [below](#on-trusting-benchmark-numbers) for why that turned out
to be non-negotiable. The chronofast column is the public class API, not the raw layer.

Nothing is timed until it has been proved correct: every contender is compared against a
reference on 200 spread indices first, and any that disagrees is reported and excluded. A fast
wrong answer is not a result. Day.js is excluded from one row for exactly this reason.

Full tables in [`REPORT.md`](./REPORT.md); reproduce with `npm run bench:all`.

### Node 24.13 (V8 13.6)

| Operation | `Date` | **chronofast** | Day.js | Temporal native | temporal-polyfill | vs `Date` |
|---|--:|--:|--:|--:|--:|--:|
| Parse ISO-8601 UTC | 129 | **37** | 292 | 314 | 2,793 | 4× |
| Parse ISO-8601 with offset | 146 | **56** | 1,158 | 353 | 3,177 | 3× |
| Format to ISO-8601 | 507 | **62** | 647 | 1,390 | 2,763 | 8× |
| Format `YYYY-MM-DD` | 519 | **43** | 1,427 | 5,973 | 5,069 | 12× |
| Add 7 days | 88 | **4** | 998 | 7,431 | 8,144 | 22× |
| Add 1 month, clamped | 228 | **31** | 2,753 | 7,539 | 8,121 | 7× |
| Truncate to start of day | 111 | **11** | 600 | 5,395 | 6,609 | 10× |
| Calendar days between | 219 | **6** | 1,506 | 12,816 | 51,235 | 38× |
| Read all six fields | 111 | **73** | 181 | 6,377 | 4,798 | 2× |
| ISO day of week | 47 | **6** | 146 | 4,829 | 4,485 | 8× |
| ISO-8601 week number | 232 | **27** | 6,142 | 5,135 | 5,425 | 9× |
| Parse → +30 days → format | 719 | **102** | 1,905 | 9,217 | 12,385 | 7× |

### Bun 1.3.14 (JavaScriptCore)

Bun has no native Temporal, so that column is absent. JavaScriptCore's `Date` formats roughly
three times faster than V8's, which is why the formatting margins here are much narrower — the
same library code against a stronger baseline.

| Operation | `Date` | **chronofast** | Day.js | temporal-polyfill | vs `Date` |
|---|--:|--:|--:|--:|--:|
| Parse ISO-8601 UTC | 156 | **28** | 276 | 2,984 | 6× |
| Parse ISO-8601 with offset | 165 | **43** | 680 | 3,645 | 4× |
| Format to ISO-8601 | 162 | **101** | 248 | 3,265 | 2× |
| Format `YYYY-MM-DD` | 176 | **59** | 1,114 | 5,350 | 3× |
| Add 7 days | 73 | **3** | 671 | 9,331 | 27× |
| Add 1 month, clamped | 160 | **30** | 2,148 | 8,982 | 5× |
| Truncate to start of day | 82 | **4** | 533 | 7,573 | 19× |
| Calendar days between | 167 | **3** | 1,466 | 31,700 | 66× |
| Read all six fields | 63 | **30** | 118 | 5,095 | 2× |
| ISO day of week | 48 | **3** | 114 | 4,910 | 18× |
| ISO-8601 week number | 186 | **25** | 4,886 | 5,422 | 7× |
| Parse → +30 days → format | 399 | **135** | 1,178 | 13,617 | 3× |

### Time zones

| Operation | `Date` + `Intl` | **chronofast** | Day.js | Temporal native | temporal-polyfill | vs `Date` |
|---|--:|--:|--:|--:|--:|--:|
| **Node 24.13** | | | | | | |
| UTC offset for an instant | 2,621 | **20** | 49,969 | 133,467 | 8,017 | 129× |
| Format as local ISO with offset | 3,083 | **94** | 56,175 | 201,800 | 7,676 | 33× |
| Add 1 local day across DST | 8,434 | **50** | *wrong answer* | 204,383 | 10,094 | 170× |
| Local midnight | 9,328 | **69** | 112,614 | 203,771 | 9,239 | 135× |
| Bucket 10,000 instants by local day | 32,004,300 | **230,080** | 913,779,300 | 1,862,478,600 | 89,347,500 | 139× |
| **Bun 1.3.14** | | | | | | |
| UTC offset for an instant | 1,925 | **14** | 36,100 | — | 7,067 | 138× |
| Format as local ISO with offset | 2,108 | **141** | 39,994 | — | 8,581 | 15× |
| Add 1 local day across DST | 6,126 | **53** | *wrong answer* | — | 12,980 | 115× |
| Local midnight | 6,676 | **66** | 78,650 | — | 9,963 | 102× |
| Bucket 10,000 instants by local day | 22,049,800 | **199,586** | 553,411,100 | — | 84,192,800 | 110× |

**Read these rows carefully.** chronofast's advantage here is the offset cache. The `Date`
baseline caches the `Intl.DateTimeFormat` — the single biggest win available to it — but not
the offset, because the naive approach has nowhere obvious to put such a cache. These rows say
*caching beats not caching*, which is a fair thing to measure but is not the same claim as
*chronofast is 129× faster than Intl*.

Two results here are worth more attention than chronofast's own numbers:

**Native Temporal is the slowest contender on zones**, by an order of magnitude over its own
polyfills — 133 µs for one offset lookup, 1.86 s to bucket ten thousand instants. V8's
`ZonedDateTime` goes back through ICU on every call with no offset caching. If you are choosing
between Temporal and something else because of zone-heavy workloads, this does not improve when
the native implementation ships; it is the native implementation.

**Day.js is excluded from the DST row because it gets it wrong.** `dayjs(ms).tz(zone).add(1,
'day')` moves 24 hours across a spring-forward boundary, where `Date`, both Temporal polyfills,
native Temporal and chronofast all move 23. Its `.tz()` is a formatting wrapper over a UTC
instant rather than a zone-aware calendar, so `add` stays on the instant timeline and the local
day is lost — and the offset it then prints is the pre-arithmetic one. The correctness gate
caught it in every run on both runtimes, so the row has no timing.

### One API note the numbers expose

"Read all six calendar fields" is the only row where the class layer costs meaningfully more
than the raw functions — 73 ns against the raw layer's 25 ns. Reading `p.year`, `p.month`,
`p.day` … is six independent getters doing six civil conversions of the same value.
`ChronoPlain#fields()` does one:

```ts
const p = ChronoPlain.parse('2024-03-15T10:30:00');

p.year; p.month; p.day; p.hour; p.minute; p.second;   // 69 ns - six conversions
const { year, month, day, hour, minute, second } = p.fields();   // 27 ns - one
```

Reach for `fields()` whenever you want three or more fields off the same value.

### Allocation

Adding seven days to an instant, approximate bytes allocated per operation on Node:

| | from epoch ms | from an existing instance |
|---|--:|--:|
| chronofast (raw) | **16** | — |
| chronofast (class) | 97 | **16** |
| `Date` | 145 | 129 |
| Day.js | 1,220 | 644 |
| Temporal native | 3,069 | 2,076 |
| `@js-temporal/polyfill` | 8,275 | 7,298 |
| `temporal-polyfill` | 22,969 | 9,920 |

In a request handler touching a few dates this is irrelevant. In a loop over ten thousand log
lines it is the whole story, and it shows up in the p99 as GC pauses.

## API

Four immutable types. Every method returns a new instance; nothing mutates.

|  | has a moment? | has calendar fields? | carries a zone? |
|---|:-:|:-:|:-:|
| `ChronoInstant` | yes | — | — |
| `ChronoPlain` | — | yes | — |
| `ChronoDate` | — | date only | — |
| `ChronoZoned` | yes | yes | yes |

The gaps are enforced, not merely documented. `ChronoInstant` has no `hour`; `ChronoPlain`
has no `epochMilliseconds`; `ChronoDate` has no `addHours`. Reading a field a value cannot
answer is a `TypeError` in JavaScript and a compile error in TypeScript, rather than a
plausible-looking wrong number.

### `ChronoInstant` — a point on the UTC timeline

```ts
ChronoInstant.parse('2024-03-15T10:30:00.000Z')   // throws on malformed input
ChronoInstant.tryParse(untrusted)                 // null instead of throwing
ChronoInstant.fromEpochMs(1710498600000)          // throws unless integral and in range
ChronoInstant.fromDate(new Date())
ChronoInstant.now()                               // UTC — see "Reading now" below
```

| | |
|---|---|
| **Value** | `epochMilliseconds` `isValid` `valueOf()` |
| **Arithmetic** | `addMilliseconds` `addSeconds` `addMinutes` `addHours` `addDays` |
| **Difference** | `millisecondsUntil` `secondsUntil` `minutesUntil` `hoursUntil` `daysUntil` |
| **Compare** | `equals` `isBefore` `isAfter` `ChronoInstant.compare` |
| **Convert** | `inZone(tz)` → `ChronoZoned` &nbsp;·&nbsp; `toUtcPlain()` → `ChronoPlain` &nbsp;·&nbsp; `toDate()` |
| **Output** | `toISOString()` `toISODate()` `toJSON()` `toString()` `toLocaleString()` |

**It has no calendar fields and no month arithmetic.** A moment is not a date until a zone
reads it, so `.year`, `.hour` and `.addMonths` are absent by design:

```ts
const t = ChronoInstant.parse('2024-03-15T10:30:00.000Z');

t.toUtcPlain().year                  // 2024   — the UTC reading, asked for by name
t.inZone('Asia/Tokyo').hour          // 19     — the Tokyo reading
```

### `ChronoPlain` — a wall-clock reading, with no zone

The equivalent of `Temporal.PlainDateTime`. What a clock said, with nothing claiming which
clock.

```ts
ChronoPlain.parse('2024-03-15T10:30:00')
ChronoPlain.of(2024, 3, 15, 10, 30)      // month is 1-based
ChronoPlain.now()                        // the local wall clock
```

| | |
|---|---|
| **Fields** | `year` `month` `day` `hour` `minute` `second` `millisecond` |
| | `dayOfWeek` (1 = Mon … 7 = Sun) `dayOfYear` `weekOfYear` `weekYear` |
| | `fields()` — all seven from a single conversion |
| **Arithmetic** | `addMilliseconds` … `addHours` `addDays` `addWeeks` `addMonths` `addYears` |
| **Truncation** | `startOfMinute` `startOfHour` `startOfDay` `startOfWeek` `startOfMonth` `startOfYear` |
| **Difference** | `millisecondsUntil` `minutesUntil` `hoursUntil` `daysUntil` `monthsUntil` |
| **Convert** | `assumeZone(tz)` → `ChronoZoned` &nbsp;·&nbsp; `toPlainDate()` → `ChronoDate` |
| **Output** | `toPlainISOString()` `toISODate()` `toJSON()` `toLocaleString()` |

Month arithmetic clamps to the end of the target month and is leap-aware:

```ts
ChronoPlain.parse('2024-01-31T00:00').addMonths(1).toISODate()   // '2024-02-29'
ChronoPlain.parse('2023-01-31T00:00').addMonths(1).toISODate()   // '2023-02-28'
```

It has **no `toISOString()`**, because there is no offset to put after the time. Use
`toPlainISOString()`, which emits what `Temporal.PlainDateTime#toString()` emits.

### `ChronoDate` — a calendar date, with no time at all

The equivalent of `Temporal.PlainDate`. A birthday, an invoice date, a hotel night.

```ts
ChronoDate.parse('2024-03-15')
ChronoDate.of(2024, 3, 15)
ChronoDate.now('Europe/Bratislava')      // today, in that zone
```

| | |
|---|---|
| **Fields** | `year` `month` `day` `dayOfWeek` `dayOfYear` `weekOfYear` `weekYear` |
| | `daysInMonth` `daysInYear` `inLeapYear` `fields()` |
| **Arithmetic** | `addDays` `addWeeks` `addMonths` `addYears` |
| **Truncation** | `startOfWeek` `startOfMonth` `startOfYear` `endOfMonth` |
| **Difference** | `daysUntil` `weeksUntil` `monthsUntil` `yearsUntil` |
| **Convert** | `toPlain(h, mi, s, ms)` &nbsp;·&nbsp; `atTime(h, mi)` &nbsp;·&nbsp; `atStartOfDay(tz)` |
| **Output** | `toISODate()` `toJSON()` `toLocaleString()` `toLocaleDateString()` `dayIndex` |

**No `hour`, no `addHours`.** Getting to a time is something you say out loud:

```ts
const d = ChronoDate.parse('2024-03-15');

d.toPlain()                              // ChronoPlain at 00:00
d.atTime(14, 30)                         // ChronoPlain at 14:30
d.atStartOfDay('Europe/Bratislava')      // ChronoZoned — a real moment, DST-correct
d.addDays(7).toISODate()                 // '2024-03-22'
```

It refuses to *render* a time as well. `d.toLocaleString('sk-SK', { hour: '2-digit' })`
throws a `TypeError` rather than answering `'00'`, and there is no `toLocaleTimeString` —
both matching `Temporal.PlainDate`. Answering with midnight would be the same
plausible-looking wrong answer the missing `hour` getter exists to prevent.

It is stored as a day index rather than a timestamp, so `b - a` is whole days and sorting
compares small integers.

### `ChronoZoned` — a moment, read through an IANA zone

```ts
ChronoZoned.parse('2024-03-15T10:30:00Z', 'Europe/Bratislava')
ChronoZoned.fromEpochMs(1710498600000, 'America/New_York')
ChronoZoned.fromLocal('Europe/Bratislava', 2024, 3, 15, 11, 30)
```

Carries both surfaces — every field of `ChronoPlain` plus `epochMilliseconds` — and adds
`offset` (milliseconds), `offsetHours`, `withZone(tz)`, `withZoneSameLocal(tz)`,
`toInstant()`, `toPlain()`, `toPlainDate()` and `startOfDay()`.

The distinction that matters is between **exact-time** and **calendar** units:

```ts
const z = ChronoZoned.fromEpochMs(Date.parse('2024-03-30T12:00:00Z'), 'Europe/Bratislava');

z.addHours(24)   // exactly 24 hours later
z.addDays(1)     // the same wall-clock time tomorrow — 23 hours, because DST starts
```

`addDays`, `addMonths`, `addYears` and `startOfDay` resolve through local wall time, so they
do what a calendar says rather than what a stopwatch says.

### Reading "now" — say which clock you mean

At 09:07 in Bratislava the instant and the local wall clock are two different readings.
Picking the wrong one is silent: the code runs, every timestamp is off by the local offset,
and anything near midnight lands on the wrong day. So chronofast makes you say which:

```ts
import { Now } from 'chronofast';

Now.instant()               // the moment, no fields              -> 07:07 in UTC terms
Now.plainDateTimeISO()      // the local wall clock, no zone       -> 09:07
Now.zonedDateTimeISO()      // the local wall clock, with its zone -> 09:07+02:00
Now.plainDateISO()          // today's local date, as a ChronoDate
Now.timeZoneId()            // 'Europe/Bratislava'
Now.minutesSinceMidnight()  // 547
```

Every method takes an optional zone and defaults to the system one. The names mirror
`Temporal.Now` on purpose, so migrating is a rename.

One thing to know: `ChronoInstant.now()` is still UTC — correct for storage, comparison and
audit trails, wrong for anything a user reads.

`Now.plainDateISO()` returns a `ChronoDate`, matching `Temporal.Now.plainDateISO()`.
Until 1.0.2 it returned a `ChronoPlain` pinned to midnight, which meant
`Now.plainDateISO().addHours(5)` compiled and gave back a value that was no longer a date.
If you want a midnight *reading* rather than a date, say so:
`Now.plainDateTimeISO(tz).startOfDay()`.

A wall-clock reading serialises with `toPlainISOString()`, which omits the `Z` rather than
claiming an offset the value does not have:

```ts
Now.plainDateTimeISO().toPlainISOString()   // '2026-09-02T09:07:00'   honest
```

### Field numbering is human, not `Date`-style

| field | range | note |
|---|---|---|
| `month` | **1–12** | January is `1`. `Date#getUTCMonth()` returns `0` — chronofast does not. |
| `day` | 1–31 | |
| `hour` | 0–23 | |
| `minute`, `second` | 0–59 | no leap seconds |
| `millisecond` | 0–999 | the finest precision carried |
| `dayOfWeek` | **1–7** | ISO: Monday is `1`, Sunday is `7` |
| `dayOfYear` | 1–366 | 1 January is `1` |
| `weekOfYear` | 1–53 | ISO-8601; see `weekYear` |

```ts
ChronoPlain.parse('2024-09-01T00:00').month   // 9, not 8
```

If you need `Date`'s Sunday-first numbering for interop, it exists under a name that cannot
be confused with the ISO one:

```ts
import { dayOfWeekSunday0 } from 'chronofast/core';   // 0 = Sunday … 6 = Saturday
```

Every range above is stated in the JSDoc, so it appears in editor tooltips and in the
generated `.d.ts` rather than only here.

The component factories (`ChronoPlain.of`, `ChronoDate.of`, and
`ChronoZoned.fromLocal`) reject fractional or impossible fields rather than balancing
them into a different date. For example, 30 February and hour 24 throw `RangeError`.

### Instants and wall-clock readings are different things

`2000-09-01T10:00Z` names a moment. `2000-09-01T10:00` does not — it is a reading off a
clock, and it only becomes a moment once you say which clock. chronofast keeps that
distinction visible instead of guessing.

**You have a value you know was recorded in a zone.** A date picker, a CSV column, a legacy
database field:

```ts
ChronoZoned.parse('2000-09-01T10:00', 'Europe/Bratislava').toISOString()
// '2000-09-01T10:00:00.000+02:00'   — stays 10:00, resolves to 08:00Z

ChronoZoned.fromLocal('Europe/Bratislava', 2000, 9, 1, 10, 0)          // from components
ChronoPlain.parse('2000-09-01T10:00').assumeZone('Europe/Bratislava')  // from a reading
```

The offset comes from the tz database for *that date*, so January gives `+01:00` and
September `+02:00` without you encoding a DST rule anywhere.

**A string that carries a designator is an exact instant**, and the zone only affects how it
is displayed:

```ts
ChronoZoned.parse('2000-09-01T10:00:00Z', 'Europe/Bratislava').toISOString()
// '2000-09-01T12:00:00.000+02:00'   — a designator means you already said which moment
```

So `ChronoZoned.parse` reads the string, not your intent: `Z` or a numeric offset means an
instant, nothing means a local reading, and an undecorated date-only string means local midnight.

### The conversions, which are easy to confuse

| | the moment | the wall-clock reading |
|---|---|---|
| `instant.inZone(tz)` | unchanged | **moves** |
| `plain.assumeZone(tz)` | **set** | unchanged |
| `zoned.withZone(tz)` | unchanged | **moves** |
| `zoned.withZoneSameLocal(tz)` | **moves** | unchanged |

```ts
const t = ChronoInstant.parse('2000-09-01T10:00:00.000Z');

t.inZone('Europe/Bratislava').toISOString()
// '2000-09-01T12:00:00.000+02:00'   same moment, read locally

t.toUtcPlain().assumeZone('Europe/Bratislava').toISOString()
// '2000-09-01T10:00:00.000+02:00'   same reading, given a zone
```

`zoned.toPlain()` and `zoned.toPlainDate()` go the other way, dropping the zone and keeping
the local reading. `assumeZone` and `atStartOfDay` accept a disambiguation mode for the two
days a year when a local time is ambiguous or does not exist.

### Ambiguous and nonexistent local times

A local time can happen twice (autumn) or never (spring). `fromLocal` and `assumeZone`
resolve this with Temporal's `'compatible'` rule by default — earlier of an ambiguous pair,
shifted forward across a gap — and accept `'earlier'`, `'later'` or `'reject'`:

```ts
// 02:30 on 2024-03-31 does not exist in Bratislava; the clock jumps 02:00 -> 03:00
ChronoZoned.fromLocal('Europe/Bratislava', 2024, 3, 31, 2, 30).toISOString()
// '2024-03-31T03:30:00.000+02:00'

ChronoZoned.fromLocal('Europe/Bratislava', 2024, 10, 27, 2, 30, 0, 0, 'reject')
// throws AmbiguousTimeError
```

### Parsing fails closed

`parse` **throws `InvalidInstantError`** — which extends `RangeError` — on anything it
cannot read. `tryParse` is the same parser with a `null` return instead of a throw.

```ts
ChronoInstant.parse('not-a-date')        // throws InvalidInstantError
ChronoInstant.tryParse('not-a-date')     // null

const t = ChronoInstant.tryParse(row.timestamp);
if (t === null) { logRejected(row); continue; }
```

This holds for `ChronoInstant`, `ChronoPlain` and `ChronoZoned` alike, and
`ChronoInstant.fromDate` refuses an invalid `Date` rather than laundering it into a
NaN-carrying instant.

**Why it is a throw and not an `isValid` flag.** An earlier version returned an instance
whose `isValid` was `false`, in the style of `Date`. That is a trap, because `NaN` makes
*both* sides of a comparison false:

```ts
const t = ChronoInstant.parse(garbage);   // the old behaviour
t.epochMilliseconds >= Date.now()         // false
t.epochMilliseconds <  Date.now()         // false, too
```

So a timestamp nobody could read did not compare *wrong* — it silently took the
else-branch of every comparison downstream. Code asking "is this slot still in the
future?" answered "no" for a value it never understood, and a caller that only handles the
true branch would hide the row rather than flag it. For a parser fed by an external API
that is the wrong direction to fail in, so the door is now closed by default and
`tryParse` is how you open it deliberately.

`Temporal.Instant.from` throws on the same inputs, so migrating code that already catches
`RangeError` needs no change.

### Precision is milliseconds, and sub-millisecond digits are dropped

An instant is one number of milliseconds. That is the reason for most of the speed on this
page, and the cost is real: extra digits are **truncated, silently**, exactly as
`Date.parse` truncates them.

```ts
ChronoInstant.parse('2026-09-02T16:30:00.123456Z').toISOString()
// '2026-09-02T16:30:00.123Z'   - the 456 is gone

Temporal.Instant.from('2026-09-02T16:30:00.123456Z').toString()
// '2026-09-02T16:30:00.123456Z' - Temporal keeps it
```

Microsecond input is **accepted, not rejected** — Postgres `timestamptz` emits microseconds
by default, and refusing it would refuse the most common real input. But it means a value
read from such a column, parsed, and written back has lost precision. If you round-trip
database timestamps through chronofast, either keep the original string alongside the
parsed value or accept the truncation deliberately. This is the one place where migrating
from `Temporal` loses information rather than merely changing syntax.

Numeric APIs do not have extra digits to discard: epoch milliseconds and arithmetic
amounts must be finite integers, as Temporal duration fields must be. Use
`addMilliseconds(500)`, not `addSeconds(0.5)`. Arithmetic throws `RangeError` instead of
returning a value outside its type's representable range. Instants and wall clocks use the
ECMAScript time range (±8.64e15 milliseconds); `ChronoDate` uses Temporal's complete
calendar-date range, from `-271821-04-19` through `+275760-09-13`.

The class constructors themselves are unchecked low-level entry points: they expect an
already-validated branded value (or day index) so the ordinary arithmetic path pays no
repeat-validation cost. Use `parse`, `of` and `from*` for numeric or untrusted input.
Manually passing a fractional, non-finite or out-of-range value violates that constructor
contract; arithmetic on such a receiver is unspecified.

### Errors

| | thrown when |
|---|---|
| `InvalidInstantError` | parsing or instant construction/arithmetic cannot produce an integral value inside the ECMAScript time range |
| `UnknownTimeZoneError` | a zone id `Intl` does not recognise |
| `AmbiguousTimeError` | `'reject'` disambiguation hits an ambiguous or nonexistent local time |

## Types

An instant is a plain `number` — that is the performance premise. Branding makes it safe at
zero runtime cost, because the brand exists only in the type system and the compiler erases
it entirely:

```ts
type EpochMs = number & { readonly [BRAND]: 'EpochMs' };
type WallMs  = number & { readonly [BRAND]: 'WallMs'  };
```

Keeping `WallMs` distinct from `EpochMs` is the most useful thing the types do: a
wall-clock reading is not an instant until a zone resolves it, because it may be ambiguous
or may not exist. The compiler refuses to confuse them.

Cost of the branding, measured against raw arithmetic — median of five runs each, every
run in its own process: **0.668 ns vs 0.664 ns**. The 0.004 ns gap sits well inside the
0.02–0.11 ns spread between runs, so the honest reading is *no measurable cost*. V8 inlines
the erased helper away entirely.

Exported types: `EpochMs`, `TimeZoneId`, `DateTimeFields`, `Disambiguation`.

## The raw layer

The classes are a thin wrapper over functions operating on plain epoch-ms numbers, which
allocate nothing at all. That layer is not part of the public API, but it is importable if
you are in a hot loop and want it:

```ts
import { parseISO, addDays, toISO } from 'chronofast/core';
import { offsetAt, formatZoned } from 'chronofast/zone';

toISO(addDays(parseISO('2024-03-15T10:30:00.000Z'), 7));
```

Treat it as a sharp tool: it uses module-scoped scratch slots for multi-value returns, so
read the results before the next call. It is also the smaller import — see
[what you actually pay in a bundle](#what-you-actually-pay-in-a-bundle).

## Limitations, stated plainly

- **Millisecond precision.** Not nanoseconds. `Temporal` is strictly more capable here.
- **Wall clocks use the ECMAScript ±8.64e15 ms range.** At the extreme instant boundaries,
  a zone offset can move the corresponding local reading beyond that range, so
  `ChronoZoned#toPlain()` throws even though the zoned instant itself remains valid.
  `ChronoZoned.parse` and `fromLocal` accept the one-day padded intermediate range needed
  to resolve such readings, but the resulting instant must still be inside ±8.64e15 ms.
- **Proleptic Gregorian, ISO calendar only.** No Hebrew, Islamic, Japanese calendars.
- **No `Duration` type**, no relative formatting, no parsing of human text.
- **The zone engine assumes at most one offset transition per UTC day**, not reversing
  within that day. True for every zone in the current IANA database.
  `offsetAtUncached()` in `chronofast/zone` is the assumption-free path, and the test suite
  uses it to validate the cache hourly across two years.
- **Cache state is process-global.** Correct under any access pattern — the test suite
  interleaves unrelated day-clusters specifically to prove it — but it does mean memory
  grows with the number of distinct days you touch.

### Where chronofast is deliberately stricter than `Date`

| Input | `Date.parse` | chronofast |
|---|---|---|
| `2023-02-29T00:00:00.000Z` | silently rolls to **2023-03-01** | `NaN` |
| `2024-03-15T24:00:00.000Z` | accepts hour 24 | `NaN` |
| `2024-03` | accepts year-month | `NaN` |

The first is a footgun worth rejecting, and `Temporal` rejects it too. The other two are
valid grammar that chronofast does not implement. All three are asserted as contract in the
test suite rather than treated as bugs.

## Builds, size, and browser support

Two outputs. `lib/` is what bundlers and Node consume; `browser/` is for people not running
a bundler at all.

```
lib/ (ESM, unminified, tree-shakeable)          raw       gzip     brotli
  TOTAL                                     42.31 kB   13.17 kB   11.36 kB

browser/ (minified, single file)                raw       gzip     brotli
  chronofast.min.js          ESM              14.59 kB    5.15 kB    4.58 kB
  chronofast.global.min.js   window global    15.04 kB    5.35 kB    4.78 kB
```

`lib/` stays unminified deliberately: bundlers minify anyway, and readable output keeps
stack traces and tree-shaking useful. Reproduce both with `npm run size`.

```html
<script type="module">
  import { ChronoInstant } from 'https://unpkg.com/chronofast/browser/chronofast.min.js';
  console.log(ChronoInstant.now().toISOString());
</script>

<!-- or as a global -->
<script src="https://unpkg.com/chronofast"></script>
<script>console.log(chronofast.ChronoInstant.now().toISOString());</script>
```

### What you actually pay in a bundle

Measured with esbuild, `bundle: true, minify: true`:

| your import | bundled | gzip |
|---|--:|--:|
| `{ ChronoInstant }` from `chronofast` | 14.20 kB | **4.98 kB** |
| `{ ChronoInstant, ChronoZoned }` | 14.21 kB | **4.98 kB** |
| `{ parseISO, toISO, addDays }` from `chronofast/core` | 4.29 kB | **1.76 kB** |
| `{ parseISO }` from `chronofast/core` | 3.21 kB | **1.28 kB** |

Note rows one and two: they are the same size. **The class API does not tree-shake the
time zone engine away.** `ChronoInstant.inZone()` statically references `ChronoZoned`,
which pulls in `zone.js`, so importing `ChronoInstant` alone still costs you the whole
engine — and adding `ChronoZoned` to the import costs nothing extra, because it was
already in your bundle.

That is a deliberate trade: `inZone()` is the most useful method on the type, and 5 kB
gzipped is a reasonable price for it. If you only ever work in UTC and the kilobytes
matter, import the raw layer instead and tree-shaking works properly:

```ts
import { parseISO, addDays, toISO } from 'chronofast/core';   // 1.76 kB gzipped
```

Minification only happens in a production build — `vite build`, webpack
`mode: 'production'`, `next build`. A dev server serves it unminified (6.77 kB gzipped),
and Rollup or esbuild invoked directly minify only when told to.

### Which JavaScript version

| | |
|---|---|
| `lib/` compile target | **ES2022** |
| `browser/` bundle target | **ES2020** |
| Syntax actually emitted | **ES2015** — classes, arrow functions, `const`/`let`, template literals. No optional chaining, no nullish coalescing, no private fields, no `BigInt`. |
| Runtime APIs required | `Map`, `Set`, `Int32Array`, `Uint8Array`, `Number.isFinite`, `Intl.DateTimeFormat` |

The ES2022 target is a floor on the *typings*, not on the output: `Intl.DateTimeFormatOptions`
only knows about `timeZoneName: 'longOffset'` from the ES2020 lib onward. Compiled down to
ES2015 — even to ES5 — the emitted code still passes the full correctness gate.

**The real browser constraint is `Intl`, not syntax.** `timeZoneName: 'longOffset'` is
ECMA-402 2021: Chrome 95+, Firefox 91+, Safari 15.4+. Older engines throw when the option is
*constructed*, so chronofast feature-detects it once per realm and falls back to
reconstructing the wall clock from `formatToParts` — slower per uncached lookup, identical
results. `hasFastOffsetPath()` in `chronofast/zone` reports which path you are on, and the
fallback is covered by its own differential test (`test/verify-legacy-intl.js`) rather than
left to rot.

Below that, everything needed is ES2015-era. Time zones require `Intl` with full ICU; on a
Node build compiled with `small-icu`, only UTC will resolve.

## Testing

```bash
npm test                     # build, then every suite below
npm run test:unit            # 551 assertions across 71 suites, ~0.5s
npm run test:differential    # the wide sweep against Date
npm run test:temporal        # 724k checks against Temporal, ~3s
npm run test:temporal:deep   # 5.5M checks, every IANA zone, ~35s
npm run test:legacy          # the Intl fallback path, on a simulated old engine
npm run test:bundle          # the minified browser builds
npm run release:check        # 76 publish preconditions
```

| Suite | What it protects |
|---|---|
| `parse.test.js` | Every accepted ISO form and every rejected one, exactly. The library has **two** parse paths — a constant-index fast path for the canonical 24-character form and a general scanner — so a large part of this file exists to prove they cannot drift apart. |
| `format.test.js` | Byte-exact output. The emitters build the whole result in one `String.fromCharCode` call, where an off-by-one produces a wrong string rather than a crash. Includes the day-string memo under interleaved access. |
| `arithmetic.test.js` | The end-of-month clamping matrix across every month, every day 28–31, leap and non-leap and ÷100 and ÷400 years, ±24 months — 4,000-plus combinations checked for "never lands in the wrong month". |
| `fields.test.js` | Field access against `Date`, ISO week numbering against hand-checked values, and the **live-binding scratch slots** — a real bug once shipped in this repo's benchmark harness by copying them with object spread. Also guards against returning `-0`. |
| `zone.test.js` | Known offsets, DST transitions resolved to the second, cache-vs-uncached agreement hourly across two years for twelve zones, and order-independence: forwards, backwards, shuffled, and with several zones interleaved. |
| `api.test.js` | The published contract. Exact export list, exact method and getter names, no internals leaking, every error type reachable, immutability of every method. |
| `perf-smoke.test.js` | A catastrophe detector with ~20× headroom. Catches a cache that stopped caching or an accidental O(n) scan; deliberately asserts no timing ratios. |
| `invalid.test.js` | That a value which cannot be a date never serialises to something date-shaped. `NaN`, both infinities and anything outside the ECMAScript range, on every type and every output method — the guard here once tested only `NaN`, and `Infinity` produced `"Infinity-03-NaNT00:00:00.NaN"`. Also pins the fail-closed parse contract and the bounded zone cache. |
| `date.test.js` | `ChronoDate` against `Temporal.PlainDate` — every field, arithmetic across ±240 months and ±240 years, end-of-month clamping, and the absences: no `hour`, no `addHours`, no `toLocaleTimeString`. |
| `locale.test.js` | Locale output against Temporal across seven locales and every option shape. Asserts the methods are *defined* rather than inherited: `Object.prototype.toLocaleString` exists on everything and silently returns the ISO string, so feature detection cannot see it missing. |

Two suites run outside the unit runner because they need a modified environment:
`test/verify-legacy-intl.js` patches `Intl.DateTimeFormat` to throw exactly as a pre-2021
engine does and cross-checks the fallback against the fast path across eight zones, and
`scripts/verify-browser-bundle.js` exercises the **minified** artefacts including 20,000
differential samples against `Date`.

### The differential suite

`test/differential-temporal.js` is the one that finds things nobody thought to write a test
for. The claim being made — the same answers as `Temporal`, faster — is mechanically
checkable, so it is checked mechanically: generate inputs, run both, assert equality.

```
npm run test:temporal          724,360 checks, ~3s
npm run test:temporal:deep   5,552,192 checks, all 418 IANA zones, ~35s
```

Seven sections: UTC engine fields, calendar arithmetic, offsets across every zone the host
knows, **real DST transitions located with `getTimeZoneTransition`** and probed at ±1 ms,
±1 s, ±1 min and ±1 h, all four disambiguation modes at genuine gaps and overlaps, round
trips, and locale output. Sampling is deliberately biased — three quarters into the era real
data lives in, with a tail to the range extremes — and transitions are *found* rather than
guessed, because DST defects live within a second of a boundary and uniform sampling never
reaches them. Every failure prints the input needed to reproduce it.

It also knows about two things that are not defects. chronofast reads offsets from the
host's `Intl`; `temporal-polyfill` carries its own copy of the tz database, and the two
genuinely differ for Morocco, Cairo and Rio Gallegos, where DST follows a lunar calendar
that different tzdb snapshots project differently. Separately, V8's native `Temporal`
differs from `Date` itself on formatting options. In both cases siding with the platform is
the intended behaviour, so those are reported separately rather than failed — otherwise the
suite would cry wolf on every tz-data bump and someone would eventually switch it off.

Everything is deterministic — a seeded LCG, no `Date.now()`, no `Math.random()` — so a
failure reproduces from the test name alone.

### On trusting benchmark numbers

Two things in this harness exist because the obvious version of it was measurably wrong.

**Every measurement runs in its own process.** `measure()` calls the function under test
through a shared call site. As distinct closures pass through it, that site goes megamorphic
— so identical code measured *second* in a process reads far slower than the same code
measured first. Eight byte-identical functions, run through one shared loop:

| position | ns/op |
|---|--:|
| 1st measured | 0.694 |
| 2nd–8th measured | ~3.97 |
| each alone in a fresh process | 0.685–0.689 |

A 5.7× penalty for measurement order. Giving each measurement its own closure does not help
— V8 keys the feedback to the function literal. A fresh process per `(scenario, contender)`
is the only thing that reproduces ground truth, so that is what the harness does. Reproduce
with `node bench/probe-ic-pollution.js`.

**Batches are checked against clock granularity.** Process isolation then exposed a second
bug: with a cold cache the first zone call constructs an `Intl.DateTimeFormat` and probes
days, which alone exceeded the target batch time — so the calibrator left the batch size at
one iteration and every sample became a single ~200 ns operation read through a 100 ns
clock. Four unrelated operations all reported exactly 5.00M ops/s. There is now a priming
phase before calibration, and any batch shorter than 50 timer ticks is flagged
`LOW RESOLUTION` in the output and in the JSON.

**The reported margin of error still understates the truth.** It measures scatter between
samples, not variation between runs. Two scenarios here have swung 37 and 53 percentage
points between consecutive runs of identical code while each reported an RME under 3%. Run
the benchmark several times with different `--tag`s before believing any single delta —
including the ones in this README.

## License

MIT © [Bruno Laurinec](https://github.com/brunolau)
