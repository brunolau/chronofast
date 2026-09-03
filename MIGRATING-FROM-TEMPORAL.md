# Migrating from Temporal to chronofast

Every claim in this document was checked against the built library and against
`temporal-polyfill` by running it, not by reading the source. Where the two disagree, the
disagreement is stated.

## Read this first

**This is not a drop-in replacement.** Most of the surface maps one-to-one, but three
differences are silent — code compiles, runs, and is wrong — and they are listed before the
translation tables for that reason.

chronofast models **four** types. Temporal models seven:

| Temporal | chronofast | is it a moment? | carries a zone? |
|---|---|---|---|
| `Instant` | `ChronoInstant` | yes | no |
| `PlainDateTime` | `ChronoPlain` | no — a clock reading | no |
| `PlainDate` | `ChronoDate` | no — a calendar date | no |
| `ZonedDateTime` | `ChronoZoned` | yes | yes |
| `PlainTime` | **none** | no | no |
| `PlainYearMonth`, `PlainMonthDay` | **none** | no | no |
| `Duration` | **none** | — | — |

The split is enforced by *removing* capabilities rather than documenting them away:

- `ChronoInstant` has **no** `year`, `hour` or `addMonths`. A moment has no calendar fields
  until you say which zone reads it.
- `ChronoPlain` has **no** `epochMilliseconds`, `toDate` or `inZone`. A clock reading is not
  a moment until you say which zone it was read in.
- `ChronoDate` has **no** `hour` and **no** `addHours`. A date is not a time.
- `ChronoZoned` has both, legitimately — a zone is exactly what converts between them.

TypeScript enforces this: `plain < instant` is a compile error
(`Operator '<' cannot be applied to types 'ChronoPlain' and 'ChronoInstant'`). Plain
JavaScript does not, and neither does TypeScript once you unwrap either side —
`p.valueOf() < i.valueOf()` compares a wall clock against an epoch instant and silently
answers with whichever number is larger. See landmine 3.

---

## Sizing the job before you start

Counts from one production codebase: **matching source lines**, via `ripgrep` over `.ts`,
`.tsx`, `.js` and `.vue`, with dependencies and build output excluded. Counting raw
occurrences instead, or including `node_modules` and bundled output, inflates these by more
than an order of magnitude and tells you nothing about how much code you would touch. Your
own numbers will differ; the point is which questions to ask:

| what to count | found here | migrates how |
|---|---:|---|
| `Temporal.Now.*` | 2,549 | **name-for-name rename**, the `Now` namespace mirrors it |
| — of which `Temporal.Now.plainDateTimeISO` | 1,647 | `Now.plainDateTimeISO()` |
| `Temporal.PlainDateTime` | 3,093 | `ChronoPlain` |
| `Temporal.PlainDate` | 752 | `ChronoDate` |
| `Temporal.Instant` | 57 | `ChronoInstant` |
| `Temporal.ZonedDateTime` | 26 | `ChronoZoned` |
| `.toLocaleString(` | 70 | supported since 1.0.1 — see landmine 4 |
| `.with({` | 69 | **no equivalent**, rebuild the value |
| `Temporal.PlainTime` | 39 | **no equivalent**, model as minutes |
| `.round({` | 5 | truncation only, via `startOf*` |
| `Temporal.Duration` | **0** | **no equivalent** |
| `epochNanoseconds` | **0** | **no equivalent** |

The two hardest gaps — `Duration` and nanosecond precision — turned out to be unused here.
That will not be true everywhere, so count before deciding. `.with({` is the largest real
gap at 69 sites.

---

## The four landmines

### 1. `ChronoInstant.now()` is UTC — use `Now.*` instead

`Temporal.Now.plainDateTimeISO()` reads the **local** clock. `ChronoInstant.now()` reads
**UTC**. At 09:07 in Central Europe those are two hours apart, and readings near midnight
land on the **wrong day**, which propagates into day bucketing and "is it today".

The `Now` namespace mirrors `Temporal.Now`, so those sites are a mechanical rename:

| Temporal | chronofast | returns |
|---|---|---|
| `Temporal.Now.instant()` | `Now.instant()` | `ChronoInstant` |
| `Temporal.Now.plainDateTimeISO()` | `Now.plainDateTimeISO()` | `ChronoPlain` |
| `Temporal.Now.plainDateISO()` | `Now.plainDateISO()` | `ChronoDate` |
| `Temporal.Now.zonedDateTimeISO(z)` | `Now.zonedDateTimeISO(z)` | `ChronoZoned` |
| `Temporal.Now.timeZoneId()` | `Now.timeZoneId()` | `string` |
| `Temporal.Now.plainTimeISO()` | `Now.minutesSinceMidnight()` | `number`, not a type |

All take an optional zone and default to the system zone, as Temporal does.

Every return type lines up with Temporal's. `Now.plainDateISO()` returned a `ChronoPlain`
pinned to midnight before 1.0.2 — carrying `hour` and `addHours`, both meaningless on a date
— and now returns a `ChronoDate`, as `Temporal.Now.plainDateISO()` returns a `PlainDate`.
`ChronoDate.now(tz)` is the same value by another name. If you want a midnight *reading*
rather than a date, `Now.plainDateTimeISO(tz).startOfDay()` says so.

**`ChronoInstant.now()` still exists and is still UTC.** Right for storage, comparison and
audit trails. Wrong for anything a user reads.

### 2. The serialised string is different

```ts
Temporal.PlainDateTime.from('2024-03-15T10:30:00').toString()
// '2024-03-15T10:30:00'          no designator, no milliseconds

ChronoInstant.parse('2024-03-15T10:30:00Z').toISOString()
// '2024-03-15T10:30:00.000Z'     always a Z, always three fractional digits
```

Use the type that matches the value:

```ts
ChronoPlain.parse('2024-03-15T10:30:00').toPlainISOString()   // '2024-03-15T10:30:00'
ChronoDate.parse('2024-03-15').toISODate()                    // '2024-03-15'
```

`ChronoPlain#toPlainISOString()` emits exactly what `Temporal.PlainDateTime#toString()`
does, including the trailing-zero trimming (`.100` renders as `.1`) — verified equal across
all 1,000 millisecond values. `ChronoDate#toISODate()` matches `PlainDate#toString()`.

Reserve `toISOString()` for genuine instants, where the `Z` or the offset is true. This is
the difference that corrupts stored data rather than breaking a build, so audit every
`toString()` on a date that crosses a process boundary — database, API, cache key, log line
you grep.

### 3. Two coordinate systems, one number type

`ChronoPlain#valueOf()` returns **wall-clock** milliseconds. `ChronoInstant#valueOf()`
returns **epoch** milliseconds. For the same real moment those differ by the zone offset:

```ts
const i = ChronoInstant.parse('2026-09-02T12:30:00Z');
const p = i.inZone('Europe/Bratislava').toPlain();
i.valueOf()   // 1788352200000   epoch
p.valueOf()   // 1788359400000   wall — two hours larger
```

TypeScript blocks `p < i` outright. It does **not** block `p.valueOf() < i.valueOf()`, and
plain JavaScript blocks neither. Temporal avoids the whole question by making `valueOf()`
throw; chronofast keeps it so that `<`, `>` and `-` work within a single type, and pays for
that with this sharp edge. Convert before comparing across types:

```ts
p.assumeZone(zone)            // ChronoPlain -> ChronoZoned, a real moment
i.inZone(zone).toPlain()      // ChronoInstant -> ChronoPlain, a reading
```

Note also that `==` and `===` compare object identity, so two values for the same moment are
never `===` even though `<=` and `>=` both hold. Use `.equals()`.

### 4. Millisecond precision, and silent truncation

An instant is one number of milliseconds. `epochNanoseconds` does not exist, and
sub-millisecond digits are **truncated silently** on parse — byte-identically to
`Date.parse`:

```ts
ChronoInstant.parse('2026-09-02T16:30:00.123456Z').toISOString()
// '2026-09-02T16:30:00.123Z'      the 456 is gone, no error

Temporal.Instant.from('2026-09-02T16:30:00.123456Z').toString()
// '2026-09-02T16:30:00.123456Z'   Temporal keeps it
```

Microsecond input is **accepted, not rejected**, because Postgres `timestamptz` emits
microseconds by default and refusing it would refuse the most common real input. But a value
read from such a column, parsed, and written back has lost precision. This is the one place
where migrating loses information rather than only changing syntax.

---

## What changed since 1.0.0, if you read an earlier version of this guide

As of 1.1.0, parity moved closer to Temporal in five places:

- **The component factories validate like Temporal's constructors.** `ChronoPlain.of`,
  `ChronoDate.of`, `ChronoZoned.fromLocal`, `atTime` throw `RangeError` on impossible
  fields (`of(2023, 2, 29)`), instead of silently balancing the way `Date` does. Note the
  one nuance in the *Constructing* table below: `Temporal.PlainDateTime.from({...})`
  **clamps** such fields by default (`overflow: 'constrain'` gives Feb 28); chronofast's
  `of()` is the constructor's strictness, not `from`'s leniency. Pass balanced fields, or
  keep `Temporal.from`'s clamping as your own explicit step.
- **Numeric input and arithmetic fail closed.** Epoch milliseconds and arithmetic amounts
  must be finite integers, and arithmetic throws `RangeError`/`InvalidInstantError`
  instead of returning a value outside the type's representable range — as Temporal's
  arithmetic does at its instant limits.
- **Difference methods keep the full `Number` range.** `secondsUntil` over a ~68-year
  interval used to wrap to a wrong-signed int32 value; all `*Until` methods now match
  Temporal's totals at any range.
- **Zero-duration zoned arithmetic is an identity.** `addDays(0)` and friends, and
  `withZoneSameLocal` naming the current zone, return the exact stored instant — the
  later occurrence of a DST fold no longer collapses to the earlier one. This matches
  Temporal's zero-duration semantics.
- **`ChronoDate` covers Temporal's complete `PlainDate` range**, `-271821-04-19` through
  `+275760-09-13`; the first day used to throw on parse.

Four statements that used to be here are no longer true:

- **"chronofast returns a sentinel on bad input."** It throws now.
  `ChronoInstant.parse('garbage')` raises `InvalidInstantError`, which extends `RangeError`,
  so `catch (e) { if (e instanceof RangeError) }` written against Temporal keeps working
  unchanged. `tryParse` returns `null` if you want the non-throwing door.
- **"`toLocaleString` is not implemented — use `Intl.DateTimeFormat` directly."** Every type
  implements `toLocaleString` and `toLocaleDateString`, matching its Temporal counterpart
  across locales and option shapes. `toLocaleTimeString` exists on the three types that
  carry a time; `ChronoDate` has no such method, as `Temporal.PlainDate` has none.
- **"`ChronoInstant` can stand in for `PlainDateTime`."** It cannot; it has no calendar
  fields at all. `ChronoPlain` is the equivalent.
- **"`Now.plainDateISO()` returns a `ChronoPlain` pinned to midnight."** As of 1.0.2 it
  returns a `ChronoDate`, so the `Now.*` block is now a rename with no exceptions.

---

## Translation table

### Constructing

| Temporal | chronofast |
|---|---|
| `Temporal.Now.instant()` | `Now.instant()` |
| `Temporal.Now.plainDateTimeISO()` | `Now.plainDateTimeISO()` |
| `Temporal.Now.plainDateISO()` | `Now.plainDateISO()` or `ChronoDate.now(tz)` — same type |
| `Temporal.Now.zonedDateTimeISO(z)` | `Now.zonedDateTimeISO(z)` |
| `Temporal.Now.timeZoneId()` | `Now.timeZoneId()` |
| `Temporal.Now.plainTimeISO()` | `Now.minutesSinceMidnight()` — a number |
| `Temporal.Instant.from(s)` | `ChronoInstant.parse(s)` |
| `Temporal.Instant.fromEpochMilliseconds(n)` | `ChronoInstant.fromEpochMs(n)` |
| `Temporal.PlainDateTime.from(s)` | `ChronoPlain.parse(s)` |
| `Temporal.PlainDateTime.from({year, month, day, hour})` | `ChronoPlain.of(y, m, d, h, mi, s, ms)` |
| `Temporal.PlainDate.from(s)` | `ChronoDate.parse(s)` |
| `Temporal.PlainDate.from({year, month, day})` | `ChronoDate.of(y, m, d)` |
| `Temporal.ZonedDateTime.from(s)` | `ChronoZoned.parse(s, zone)` |
| `Temporal.ZonedDateTime.from({...})` | `ChronoZoned.fromLocal(zone, y, m, d, h, mi, s, ms)` |
| `Temporal.PlainTime.from(s)` | **no equivalent** — model time of day as minutes |
| — | `X.tryParse(s)` — same parser, returns `null` instead of throwing |

`ChronoPlain.of` and `ChronoDate.of` take **1-based months**, as Temporal does — and
they validate like Temporal's *constructors*: impossible fields throw `RangeError`, they
are not balanced. `Temporal.PlainDateTime.from({...})` differs from its own constructor
here — its default `overflow: 'constrain'` clamps Feb 29 to Feb 28 rather than throwing —
so a site relying on that clamping must clamp explicitly before calling `of()`.

Fractional or non-finite numeric input is rejected everywhere (`fromEpochMs(0.5)`,
`addSeconds(0.25)` throw), matching Temporal's integer duration fields.

### Reading

Which fields exist depends on the type, deliberately:

| field | `ChronoInstant` | `ChronoPlain` | `ChronoDate` | `ChronoZoned` |
|---|:-:|:-:|:-:|:-:|
| `year` `month` `day` | — | yes | yes | yes |
| `hour` `minute` `second` `millisecond` | — | yes | — | yes |
| `dayOfWeek` `dayOfYear` `weekOfYear` `weekYear` | — | yes | yes | yes |
| `daysInMonth` `daysInYear` `inLeapYear` | — | — | yes | — |
| `epochMilliseconds` | yes | — | — | yes |
| `offset` `offsetHours` | — | — | — | yes |
| `fields()` | — | yes | yes | yes |

- Months are **1-based** on every type. January is 1, not 0.
- `dayOfWeek` is **ISO 1–7**, Monday is 1 — same as Temporal.
- `.offset` is **milliseconds**, not a `'+02:00'` string. `.offsetHours` is the number of
  hours. Neither is Temporal's string form.
- `.epochNanoseconds` does not exist anywhere.
- For `daysInMonth` / `inLeapYear` on a type that lacks them, `daysInMonth(y, m)` and
  `isLeapYear(y)` are free functions in `chronofast/core`.
- Reading three or more fields off one value should use `fields()`, which does one calendar
  conversion instead of one per getter.

### Arithmetic

| Temporal | chronofast |
|---|---|
| `.add({ days: 1 })` | `.addDays(1)` |
| `.add({ hours: 2, minutes: 30 })` | `.addHours(2).addMinutes(30)` |
| `.subtract({ days: 1 })` | `.addDays(-1)` |
| `.until(b)` / `.since(b)` | `.daysUntil(b)`, `.monthsUntil(b)`, `.hoursUntil(b)` — numbers |
| `.with({ hour: 9, minute: 0 })` | **no equivalent** — rebuild with `ChronoPlain.of(...)` |
| `.round({ smallestUnit: 'day' })` | `.startOfDay()` and friends — truncation only |
| `Temporal.PlainDate.compare(a, b)` | `ChronoDate.compare(a, b)` |
| `.equals(b)` | `.equals(b)` |
| — | `.isBefore(b)`, `.isAfter(b)` |

End-of-month clamping matches Temporal's `constrain` exactly: 31 Jan + 1 month is 28/29 Feb,
29 Feb + 1 year is 28 Feb. Verified across ±240 months and ±240 years on 15 spread dates.

### Zones and conversions

| Temporal | chronofast |
|---|---|
| `instant.toZonedDateTimeISO(z)` | `instant.inZone(z)` |
| `zoned.toInstant()` | `zoned.toInstant()` |
| `zoned.toPlainDateTime()` | `zoned.toPlain()` |
| `zoned.toPlainDate()` | `zoned.toPlainDate()` — the **local** date |
| `plainDateTime.toZonedDateTime(z)` | `plain.assumeZone(z)` |
| `plainDate.toZonedDateTime(z)` | `date.atStartOfDay(z)` |
| `plainDateTime.toPlainDate()` | `plain.toPlainDate()` |
| `zoned.withTimeZone(z)` | `zoned.withZone(z)` — same instant |
| `zoned.startOfDay()` | `zoned.startOfDay()` |
| `instant.toZonedDateTimeISO('UTC').toPlainDateTime()` | `instant.toUtcPlain()` |
| — | `zoned.withZoneSameLocal(z)` — same wall clock, no Temporal equivalent |

`assumeZone` and `atStartOfDay` take an optional disambiguation argument
(`'compatible'` by default, matching Temporal; `'reject'` throws `AmbiguousTimeError` on a
DST gap or overlap).

Two zone behaviors are worth knowing exactly:

- **`withZoneSameLocal(z)` naming the current zone is an identity** — ids compare
  case-insensitively — including when the value is the *later* occurrence of a DST fold.
  The nearest Temporal construction, `zdt.toPlainDateTime().toZonedDateTime(zone)`,
  would re-resolve that reading with `'compatible'` and collapse it to the earlier
  occurrence. Pass a disambiguation mode explicitly to ask for that re-resolution.
- **Sub-minute offsets serialize exactly.** chronofast prints Monrovia's 1970 offset as
  `-00:44:30`, which round-trips; native Temporal prints it rounded to `-00:45`, which
  does not. Strings are otherwise byte-compatible.

### Locale output

| Temporal | chronofast |
|---|---|
| `plainDateTime.toLocaleString(l, o)` | `plain.toLocaleString(l, o)` |
| `plainDate.toLocaleString(l, o)` | `date.toLocaleString(l, o)` |
| `zonedDateTime.toLocaleString(l, o)` | `zoned.toLocaleString(l, o)` |
| `instant.toLocaleString(l, o)` | `instant.toLocaleString(l, o)` |
| — | `.toLocaleDateString(l, o)` on every type; `.toLocaleTimeString(l, o)` on all but `ChronoDate` |

Defaults match their Temporal counterparts: `ChronoDate` prints a date with no clock,
`ChronoZoned` names its zone, `ChronoPlain` and `ChronoInstant` print date and time. A
`timeZone` option passed to a zoneless type is ignored, as Temporal ignores it. Asking a
`ChronoDate` for a time component throws `TypeError` rather than answering `'00'` — again
matching `Temporal.PlainDate`. Formatters are cached internally, so repeated calls do not
rebuild `Intl.DateTimeFormat`.

Two divergences are deliberate and worth knowing. chronofast follows **`Date`** on ECMA-402
option handling, where explicit components replace the defaults; V8's native `Temporal`
appends the full date and time to a `{ dateStyle }` or `{ weekday }` request instead, and
differs from `Date` itself in doing so. And chronofast reads time-zone data from the host's
`Intl`, the same source `Date` uses, rather than bundling a copy — so it tracks the platform
when tz data updates, and can differ from `temporal-polyfill`'s bundled snapshot in zones
whose rules are projected rather than fixed.

---

## Patterns

All examples assume
`import { Now, ChronoInstant, ChronoPlain, ChronoDate, ChronoZoned } from 'chronofast';`

### A value stored without a zone, known to be local

The most common real case, and what `PlainDateTime` exists for:

```ts
// Temporal
const wall = Temporal.PlainDateTime.from(row.startsAt);
const instant = wall.toZonedDateTime(venueZone).toInstant();

// chronofast — one call, because a bare string is read as a reading in that zone
const instant = ChronoZoned.parse(row.startsAt, venueZone).toInstant();

// or in two steps, if you want the reading itself
const instant = ChronoPlain.parse(row.startsAt).assumeZone(venueZone).toInstant();
```

### "Is this today, for the user?"

```ts
// Temporal
const today = Temporal.Now.plainDateISO(userZone);
const isToday = Temporal.PlainDate.compare(today, someDate) === 0;

// chronofast — ChronoDate compares as an integer day index
const isToday = ChronoDate.now(userZone).equals(someInstant.inZone(userZone).toPlainDate());
```

### Grouping records by day

```ts
// local day, as a string key
const key = instant.inZone(zone).toISODate();

// UTC day, as an integer key with no allocation, for a hot loop
import { dayIndexOf } from 'chronofast/core';
const key = dayIndexOf(epochMs);
```

### Adding a calendar day across DST

Both libraries agree, and both differ from `Date`:

```ts
zoned.addDays(1)      // same wall clock tomorrow: 23 or 25 hours across a transition
zoned.addHours(24)    // exactly 24 hours of elapsed time
```

Measured across the Central European spring-forward: `addDays(1)` elapses **23** hours,
`addHours(24)` elapses **24**.

### Date-only values

```ts
// Temporal
const d = Temporal.PlainDate.from('2024-03-15');
d.add({ days: 7 });
d.toZonedDateTime(zone);

// chronofast
const d = ChronoDate.parse('2024-03-15');
d.addDays(7);
d.atStartOfDay(zone);        // DST-correct: on a day with no midnight this is 01:00
```

`ChronoDate.parse` accepts exactly what `Temporal.PlainDate.from` accepts, including
**rejecting a trailing `Z`** — which calendar day a moment falls on depends on a zone the
string does not name — while accepting an explicit offset, which still describes a local
wall clock.

### Business-hours or time-of-day logic

`PlainTime` has no equivalent. Model time of day as minutes since midnight:

```ts
const minutes = zoned.hour * 60 + zoned.minute;
const isOpen = minutes >= 9 * 60 && minutes < 17 * 60;

// for "right now"
const now = Now.minutesSinceMidnight(venueZone);
const isOpenNow = now >= 9 * 60 && now < 17 * 60;
```

### Parsing untrusted input

```ts
// Temporal
try { d = Temporal.PlainDateTime.from(raw); } catch { d = null; }

// chronofast — same shape, since parse throws a RangeError too
try { d = ChronoPlain.parse(raw); } catch { d = null; }

// or without the throw
const d = ChronoPlain.tryParse(raw);   // null on bad input
```

---

## What has no equivalent at all

- **`Temporal.Duration`** — no duration type, no `.total()`, no `P1DT2H` strings, no
  balancing across units. Differences are returned as plain numbers.
- **`PlainTime`** — no time-of-day type. `Now.minutesSinceMidnight(tz)` covers "what time is
  it locally"; anything richer must be modelled by hand.
- **`PlainYearMonth`, `PlainMonthDay`** — no partial-date types.
- **`.with({...})`** — no field setter. Rebuild with `ChronoPlain.of` / `ChronoDate.of`.
- **`.round({...})`** — truncation only, via `startOf*`. No rounding to nearest.
- **Non-ISO calendars** — Hebrew, Islamic, Japanese and the rest. ISO 8601 only.
- **Nanosecond precision** — milliseconds only, and sub-millisecond input truncates.
- **`.offset` as a string** — it is a number of milliseconds here.

---

## A migration strategy

The two libraries coexist fine: chronofast has no global state Temporal touches, and both
deal in plain immutable values.

1. **Count first.** `Duration`, `PlainTime`, `.with({`, `.round({` and `epochNanoseconds`
   decide whether this is worth doing at all. In the codebase measured above, two of those
   five were zero — but that is a fact about that codebase, not about yours.
2. **Audit every `toString()` on a date that crosses a process boundary.** Landmine 2 is
   the one that corrupts stored data rather than breaking a build.
3. **`Temporal.Now.` to `Now.` is the safe mass rename.** Names and semantics line up
   deliberately, and it is usually the largest single block of sites. Watch the one return
   type that differs, in landmine 1.
4. **`PlainDateTime` to `ChronoPlain` and `PlainDate` to `ChronoDate`** are mechanical, but
   check each site for `.with({` and for comparisons that mix types.
5. **Start at the I/O edges.** Parsing and formatting convert cleanly and are where the
   performance difference actually shows up.

### When not to migrate

If the codebase uses `Duration` arithmetic, needs nanosecond precision, needs non-ISO
calendars, or leans hard on `.with({...})`, staying on Temporal is the right answer.
chronofast is faster and much smaller, but it is a smaller model of time, and no shim closes
that gap honestly.
