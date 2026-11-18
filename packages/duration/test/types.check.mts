import { duration } from '../src/_module/duration.mts'

duration.of('1h15m')
duration.of('1d2h3m4s5ms')
duration.of('15ms')
duration.of('1.5h')
// @ts-expect-error units out of order
duration.of('15m1h')
// @ts-expect-error unknown unit
duration.of('1w')
// @ts-expect-error negative
duration.of('-1h')
// @ts-expect-error exponent
duration.of('1e3s')
// @ts-expect-error empty
duration.of('')
// @ts-expect-error hex
duration.of('0x10s')
// @ts-expect-error space
duration.of(' 1s')
// @ts-expect-error infinity
duration.of('Infinitys')
// @ts-expect-error no digit before the point
duration.of('.5h')
// @ts-expect-error no digit after the point
duration.of('1.h')
// @ts-expect-error point after a unit
duration.of('1h.5m')
declare const text: string
// @ts-expect-error not a literal
duration.of(text)
