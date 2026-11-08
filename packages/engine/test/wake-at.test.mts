import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { wakeAt } from '../src/engine/wake-at.mts'

/** Fakes the clock at 2026-11-07 12:00 UTC for one test. */
function useClock(): void {
	vi.useFakeTimers({ now: new Date('2026-11-07T12:00:00Z') })
	onTestFinished(() => {
		vi.useRealTimers()
	})
}

describe('wakeAt', () => {
	test('wakes at the moment, not before', () => {
		// Arrange
		useClock()
		const wake = vi.fn()
		wakeAt(new Date('2026-11-07T12:00:10Z'), wake, new AbortController().signal)

		// Act
		vi.advanceTimersByTime(9_999)
		const early = wake.mock.calls.length
		vi.advanceTimersByTime(1)

		// Assert
		expect(early).toBe(0)
		expect(wake).toHaveBeenCalledOnce()
	})

	test('wakes right away when the moment has passed', () => {
		// Arrange
		useClock()
		const wake = vi.fn()

		// Act
		wakeAt(new Date('2026-11-07T11:00:00Z'), wake, new AbortController().signal)
		vi.advanceTimersByTime(0)

		// Assert
		expect(wake).toHaveBeenCalledOnce()
	})

	test('waits out delays longer than setTimeout takes', () => {
		// Arrange
		useClock()
		const wake = vi.fn()
		wakeAt(new Date('2026-12-31T12:00:00Z'), wake, new AbortController().signal)

		// Act
		vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000)
		const early = wake.mock.calls.length
		vi.setSystemTime(new Date('2026-12-31T12:00:00Z'))
		vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000)

		// Assert
		expect(early).toBe(0)
		expect(wake).toHaveBeenCalledOnce()
	})

	test('never wakes once the signal aborts', () => {
		// Arrange
		useClock()
		const wake = vi.fn()
		const controller = new AbortController()
		wakeAt(new Date('2026-11-07T12:00:10Z'), wake, controller.signal)

		// Act
		controller.abort()
		vi.advanceTimersByTime(20_000)

		// Assert
		expect(wake).not.toHaveBeenCalled()
	})
})
