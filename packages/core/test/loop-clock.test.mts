import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { startLoopClock, waitingOnSignIn } from '../src/loop/loop-clock.mts'

/** A loop budget shorter than the sign-in the test waits for. */
const budgetMinutes = 0.002

/** How long the sign-in in the test takes: twice the budget. */
const signInMs = budgetMinutes * 60_000 * 2

describe('loop clocks', () => {
	test("stop for a sign-in waited for out of any loop's scope, such as a package fetch through the proxy", async () => {
		// Arrange
		const exceeded = vi.fn()
		const clock = startLoopClock(budgetMinutes, exceeded)
		onTestFinished(() => {
			clock.stop()
		})

		// Act
		await waitingOnSignIn(() => delay(signInMs))

		// Assert
		expect(exceeded).not.toHaveBeenCalled()
	})
})
