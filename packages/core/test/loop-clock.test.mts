import { duration, sleep } from '@mesh-flow/duration'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { startLoopClock, waitingOnSignIn } from '../src/loop/loop-clock.mts'

/** A loop budget shorter than the sign-in the test waits for. */
const budget = duration.of('120ms')

/** How long the sign-in in the test takes: twice the budget. */
const signIn = duration.of('240ms')

/** For waits in tests that nothing stops. */
const neverAborted = new AbortController().signal

describe('loop clocks', () => {
	test("stop for a sign-in waited for out of any loop's scope, such as a package fetch through the proxy", async () => {
		// Arrange
		const exceeded = vi.fn()
		const clock = startLoopClock(budget, exceeded)
		onTestFinished(() => {
			clock.stop()
		})

		// Act
		await waitingOnSignIn(() => sleep(signIn, neverAborted))

		// Assert
		expect(exceeded).not.toHaveBeenCalled()
	})

	test('run out once the budget is used up after a wait, with the deadline moved on by the wait', async () => {
		// Arrange
		const exceeded = vi.fn()
		const clock = startLoopClock(budget, exceeded)
		onTestFinished(() => {
			clock.stop()
		})

		// Act
		await clock.whileWaiting(() => sleep(signIn, neverAborted))

		// Assert
		expect(exceeded).not.toHaveBeenCalled()
		await vi.waitFor(() => {
			expect(exceeded).toHaveBeenCalledWith(budget)
		})
	})

	test('keep the deadline where it was when the system clock is set back during a wait', async () => {
		// Arrange
		vi.useFakeTimers({ toFake: ['Date'] })
		onTestFinished(() => {
			vi.useRealTimers()
		})
		const exceeded = vi.fn()
		const clock = startLoopClock(budget, exceeded)
		onTestFinished(() => {
			clock.stop()
		})
		const setBack = duration.of('1h')

		// Act
		const answer = await clock.whileWaiting(async () => {
			vi.setSystemTime(setBack.before(new Date()))
			return 'approved'
		})

		// Assert
		expect(answer).toBe('approved')
		expect(exceeded).not.toHaveBeenCalled()
	})
})
