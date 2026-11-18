import { setTimeout as delay } from 'node:timers/promises'
import { duration } from '@mesh-flow/duration'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { startLoopClock, waitingOnSignIn } from '../src/loop/loop-clock.mts'

/** A loop budget shorter than the sign-in the test waits for. */
const budget = duration.of('120ms')

/** How long the sign-in in the test takes: twice the budget. */
const signIn = duration.of('240ms')

describe('loop clocks', () => {
	test("stop for a sign-in waited for out of any loop's scope, such as a package fetch through the proxy", async () => {
		// Arrange
		const exceeded = vi.fn()
		const clock = startLoopClock(budget, exceeded)
		onTestFinished(() => {
			clock.stop()
		})

		// Act
		await waitingOnSignIn(() => delay(signIn.to('ms')))

		// Assert
		expect(exceeded).not.toHaveBeenCalled()
	})
})
