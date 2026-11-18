# `@mesh-flow/duration`

Durations for mesh-flow. Time is always a `Duration`, never a number with a unit in its name: a wait, a timeout, an interval or a limit takes one, and only code that hands it to an API that takes a number, such as `setTimeout`, turns it into one.

## Usage

### Writing a duration

Write it as text, with one or more of `d`, `h`, `m`, `s` and `ms`, largest first. Only literal text compiles, so a typo fails at compile time:

```ts
import { duration } from '@mesh-flow/duration'

const reviewWindow = duration.of('1h15m')
const lookEvery = duration.of('30s')
```

Or from its parts, when they come from somewhere else. Missing parts are zero:

```ts
const tokenLifetime = duration({
	hours: 8,
	minutes: 30,
})
```

A duration spreads its parts out from the largest down, and is itself the parts `duration` takes: `duration({ minutes: 90 })` has `hours: 1` and `minutes: 30`. It reads as text in JSON and in a template string, such as `'1h30m'`.

### Durations and dates

```ts
const renewAhead = duration.of('5m')
const renewAt = renewAhead.before(expiresAt)

const deadline = reviewWindow.after(new Date())
const waited = duration.between(startedAt, new Date())
```

### Waiting and timing out

```ts
import { duration, sleep } from '@mesh-flow/duration'

await sleep(duration.of('2s'), abortSignal)

const response = await fetch(url, { signal: duration.of('30s').toAbortSignal() })
```

Both also wait out durations longer than the 24.8 days `setTimeout` keeps.

### Handing it to an API that takes a number

```ts
const timer = setTimeout(retry, lookEvery.to('ms'))
const expiresIn = tokenLifetime.to('s')
```

`to('ms')` is always whole. Larger units can be fractions.
