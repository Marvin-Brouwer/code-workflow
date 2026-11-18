import { describe, expect, it, onTestFinished } from 'vitest'
import { duration, sleep } from '../src/_module/duration.mts'
import { partsOf } from '../src/duration-text.mts'

describe('duration', () => {
	it('reads text with every unit, largest first', () => {
		// Act
		const read = duration.of('1d2h3m4s5ms')

		// Assert
		expect(read).toMatchObject({ days: 1, hours: 2, minutes: 3, seconds: 4, milliseconds: 5 })
		expect(read.to('ms')).toBe(93_784_005)
	})

	it('tells minutes from milliseconds', () => {
		// Act
		const read = [duration.of('15m'), duration.of('15ms'), duration.of('15m15ms')]

		// Assert
		expect(read.map((each) => each.to('ms'))).toEqual([900_000, 15, 900_015])
	})

	it('spreads parts out from the largest down', () => {
		// Act
		const spread = duration({ minutes: 90, seconds: 0.5 })

		// Assert
		expect(spread).toMatchObject({ days: 0, hours: 1, minutes: 30, seconds: 0, milliseconds: 500 })
		expect(String(spread)).toBe('1h30m500ms')
	})

	it('is no time at all without parts', () => {
		// Act
		const none = duration({})

		// Assert
		expect(none.to('ms')).toBe(0)
		expect(none.toString()).toBe('0ms')
	})

	it('reads as text in JSON', () => {
		// Act
		const json = JSON.stringify({ every: duration.of('1.5h') })

		// Assert
		expect(json).toBe('{"every":"1h30m"}')
	})

	it('converts to any unit', () => {
		// Arrange
		const time = duration.of('1h30m')

		// Act
		const units = [time.to('h'), time.to('m'), time.to('s'), time.to('d')]

		// Assert
		expect(units).toEqual([1.5, 90, 5400, 1 / 16])
	})

	it.each([['15m1h'], ['1w'], ['-1h'], [''], ['1h '], ['1.h']])('refuses %j at runtime too', (text) => {
		// Act
		const read = () => partsOf(text)

		// Assert
		expect(read).toThrow(RangeError)
	})

	it.each([[{ hours: -1 }], [{ minutes: Number.NaN }], [{ seconds: Number.POSITIVE_INFINITY }]])('refuses parts %j', (parts) => {
		// Act
		const make = () => duration(parts)

		// Assert
		expect(make).toThrow(RangeError)
	})

	it('moves dates', () => {
		// Arrange
		const date = new Date('2026-11-18T12:00:00Z')
		const time = duration.of('1h15m')

		// Act
		const moved = [time.after(date).toISOString(), time.before(date).toISOString()]

		// Assert
		expect(moved).toEqual(['2026-11-18T13:15:00.000Z', '2026-11-18T10:45:00.000Z'])
	})

	it('measures the time between two dates', () => {
		// Act
		const between = duration.between(new Date('2026-11-18T12:00:00Z'), new Date('2026-11-19T13:00:01Z'))

		// Assert
		expect(between.toString()).toBe('1d1h1s')
		expect(() => duration.between(new Date(1), new Date(0))).toThrow(RangeError)
	})
})

describe('toAbortSignal', () => {
	it('aborts with a TimeoutError once the time has passed', async () => {
		// Act
		const signal = duration.of('20ms').toAbortSignal()
		await new Promise((resolve) => {
			signal.addEventListener('abort', resolve, { once: true })
		})

		// Assert
		expect(signal.reason).toMatchObject({ name: 'TimeoutError' })
	})

	it('waits out a duration longer than setTimeout keeps', () => {
		// Act
		const signal = duration.of('30d').toAbortSignal()

		// Assert
		expect(signal.aborted).toBe(false)
	})
})

describe('sleep', () => {
	it('settles after the time has passed', async () => {
		// Arrange
		const started = performance.now()

		// Act
		await sleep(duration.of('20ms'), duration.of('5s').toAbortSignal())

		// Assert
		expect(performance.now() - started).toBeGreaterThanOrEqual(15)
	})

	it('settles promptly when aborted during a wait that never ends on its own', async () => {
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
