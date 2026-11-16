import { setTimeout } from 'node:timers/promises'
import { describe, expect, test } from 'vitest'
import { oneAtATime } from '../src/one-at-a-time.mts'

/** Long enough for a call that didn't wait its turn to have started. */
const waitMs = 20

/** How soon a call that stopped has to settle. */
const promptlyMs = 1000

describe('oneAtATime', () => {
	test('runs calls with one key in turn, side by side with another key, and past a failure', async () => {
		// Arrange
		const queue = oneAtATime()
		const ran: string[] = []
		const abortSignal = new AbortController().signal
		const { promise: firstMayEnd, resolve: endFirst } = Promise.withResolvers<undefined>()

		// Act
		const first = queue('a', abortSignal, async () => {
			ran.push('a1 started')
			await firstMayEnd
			throw new Error('a1 failed')
		})
		const second = queue('a', abortSignal, async () => {
			ran.push('a2')
		})
		await queue('b', abortSignal, async () => {
			ran.push('b1')
		})
		endFirst(undefined)

		// Assert
		await expect(first).rejects.toThrow('a1 failed')
		await second
		expect(ran).toEqual(['a1 started', 'b1', 'a2'])
	})

	test('settles a waiting call promptly when it stops, while the call before it never ends, and never runs it', async () => {
		// Arrange
		const queue = oneAtATime()
		const stop = new AbortController()
		let ran = false
		void queue('a', new AbortController().signal, () => new Promise<void>(() => undefined))
		const started = performance.now()

		// Act
		const waiting = queue('a', stop.signal, async () => {
			ran = true
		})
		stop.abort(new Error('The run stopped.'))

		// Assert
		await expect(waiting).rejects.toThrow('The run stopped.')
		expect(performance.now() - started).toBeLessThan(promptlyMs)
		expect(ran).toBe(false)
	})

	test('keeps a later call waiting for the one before, also when a call queued between them stops', async () => {
		// Arrange
		const queue = oneAtATime()
		const ran: string[] = []
		const abortSignal = new AbortController().signal
		const stop = new AbortController()
		const { promise: firstMayEnd, resolve: endFirst } = Promise.withResolvers<undefined>()
		const first = queue('a', abortSignal, async () => {
			ran.push('first started')
			await firstMayEnd
			ran.push('first ended')
		})
		const stopped = queue('a', stop.signal, async () => {
			ran.push('stopped')
		})

		// Act
		stop.abort(new Error('The run stopped.'))
		await expect(stopped).rejects.toThrow('The run stopped.')
		const later = queue('a', abortSignal, async () => {
			ran.push('later')
		})
		await setTimeout(waitMs)
		const whileFirstRuns = [...ran]
		endFirst(undefined)
		await Promise.all([first, later])

		// Assert
		expect(whileFirstRuns).toEqual(['first started'])
		expect(ran).toEqual(['first started', 'first ended', 'later'])
	})
})
