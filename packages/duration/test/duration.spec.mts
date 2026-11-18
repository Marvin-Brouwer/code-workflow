import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { duration, sleep } from '../src/_module/duration.mts'
import { partsOf } from '../src/duration-text.mts'

/** For waits in tests that nothing stops. */
const neverAborted = new AbortController().signal

describe('duration', () => {
	test('reads text with every unit, largest first', () => {
		// Act
		const read = duration.of('1d2h3m4s5ms')

		// Assert
		expect(read).toMatchObject({ days: 1, hours: 2, minutes: 3, seconds: 4, milliseconds: 5 })
		expect(read.to('ms')).toBe(93_784_005)
	})

	test('tells minutes from milliseconds', () => {
		// Act
		const read = [duration.of('15m'), duration.of('15ms'), duration.of('15m15ms')]

		// Assert
		expect(read.map((each) => each.to('ms'))).toEqual([900_000, 15, 900_015])
	})

	test('spreads parts out from the largest down', () => {
		// Act
		const spread = duration({ minutes: 90, seconds: 0.5 })

		// Assert
		expect(spread).toMatchObject({ days: 0, hours: 1, minutes: 30, seconds: 0, milliseconds: 500 })
		expect(String(spread)).toBe('1h30m500ms')
	})

	test('is no time at all without parts', () => {
		// Act
		const none = duration({})

		// Assert
		expect(none.to('ms')).toBe(0)
		expect(none.toString()).toBe('0ms')
	})

	test('reads as text in JSON', () => {
		// Act
		const json = JSON.stringify({ every: duration.of('1.5h') })

		// Assert
		expect(json).toBe('{"every":"1h30m"}')
	})

	test('converts to any unit', () => {
		// Arrange
		const time = duration.of('1h30m')

		// Act
		const units = [time.to('h'), time.to('m'), time.to('s'), time.to('d')]

		// Assert
		expect(units).toEqual([1.5, 90, 5400, 1 / 16])
	})

	test.each([['15m1h'], ['1w'], ['-1h'], [''], ['1h '], ['1.h']])('refuses %j at runtime too', (text) => {
		// Act
		const read = () => partsOf(text)

		// Assert
		expect(read).toThrow(RangeError)
	})

	test.each([[{ hours: -1 }], [{ minutes: Number.NaN }], [{ seconds: Number.POSITIVE_INFINITY }]])('refuses parts %j', (parts) => {
		// Act
		const make = () => duration(parts)

		// Assert
		expect(make).toThrow(RangeError)
	})

	test('takes a duration as its parts', () => {
		// Arrange
		const time = duration.of('1h15m')

		// Act
		const copied = [duration(time), duration({ ...time, minutes: 30 })]

		// Assert
		expect(copied.map(String)).toEqual(['1h15m', '1h30m'])
	})

	test('refuses a duration longer than a date can be moved', () => {
		// Arrange
		const tooLong = { seconds: 1e26 }

		// Act
		const make = () => duration(tooLong)

		// Assert
		expect(make).toThrow(RangeError)
	})

	test('moves dates', () => {
		// Arrange
		const date = new Date('2026-11-18T12:00:00Z')
		const time = duration.of('1h15m')

		// Act
		const moved = [time.after(date).toISOString(), time.before(date).toISOString()]

		// Assert
		expect(moved).toEqual(['2026-11-18T13:15:00.000Z', '2026-11-18T10:45:00.000Z'])
	})

	test('measures the time between two dates', () => {
		// Arrange
		const start = new Date('2026-11-18T12:00:00Z')
		const end = new Date('2026-11-19T13:00:01Z')

		// Act
		const between = duration.between(start, end)

		// Assert
		expect(between.toString()).toBe('1d1h1s')
	})

	test.each([[new Date(0)], [new Date(Number.NaN)]])('refuses an end before the start, or an invalid one: %s', (end) => {
		// Arrange
		const start = new Date(1)

		// Act
		const measure = () => duration.between(start, end)

		// Assert
		expect(measure).toThrow(RangeError)
	})
})

describe('toAbortSignal', () => {
	test('aborts with a TimeoutError once the time has passed', async () => {
		// Act
		const abortSignal = duration.of('20ms').toAbortSignal()
		await new Promise((resolve) => {
			abortSignal.addEventListener('abort', resolve, { once: true })
		})

		// Assert
		expect(abortSignal.reason).toMatchObject({ name: 'TimeoutError' })
	})

	test('waits out a duration longer than setTimeout keeps, in steps', () => {
		// Arrange
		vi.useFakeTimers()
		onTestFinished(() => {
			vi.useRealTimers()
		})
		const time = duration.of('30d')
		const almost = duration.of('29d23h59m59s')
		const abortSignal = time.toAbortSignal()

		// Act
		vi.advanceTimersByTime(almost.to('ms'))
		const abortedEarly = abortSignal.aborted
		vi.advanceTimersByTime(duration.of('1s').to('ms'))

		// Assert
		expect(abortedEarly).toBe(false)
		expect(abortSignal.aborted).toBe(true)
	})

	test('aborts no sooner than a later tick for no time at all, as AbortSignal.timeout does', () => {
		// Act
		const abortSignal = duration({}).toAbortSignal()

		// Assert
		expect(abortSignal.aborted).toBe(false)
	})
})

describe('sleep', () => {
	test('settles after the time has passed', async () => {
		// Arrange
		const time = duration.of('20ms')
		const timerSlack = duration.of('5ms')
		const controller = new AbortController()
		onTestFinished(() => {
			controller.abort()
		})
		const started = performance.now()

		// Act
		await sleep(time, controller.signal)

		// Assert
		expect(performance.now() - started).toBeGreaterThanOrEqual(time.to('ms') - timerSlack.to('ms'))
	})

	test('waits out a duration longer than setTimeout keeps, in steps', async () => {
		// Arrange
		vi.useFakeTimers()
		onTestFinished(() => {
			vi.useRealTimers()
		})
		const time = duration.of('30d')
		const almost = duration.of('29d23h59m59s')
		const settled = vi.fn()
		void sleep(time, neverAborted).then(settled)

		// Act
		await vi.advanceTimersByTimeAsync(almost.to('ms'))
		const settledEarly = settled.mock.calls.length
		await vi.advanceTimersByTimeAsync(duration.of('1s').to('ms'))

		// Assert
		expect(settledEarly).toBe(0)
		expect(settled).toHaveBeenCalled()
	})

	test('settles promptly when aborted during a wait that never ends on its own', async () => {
		// Arrange
		const controller = new AbortController()
		onTestFinished(() => {
			controller.abort()
		})
		const sleeping = sleep(duration.of('30d'), controller.signal)

		// Act
		controller.abort(new Error('stopped'))

		// Assert
		await expect(sleeping).rejects.toThrow('stopped')
	})
})
