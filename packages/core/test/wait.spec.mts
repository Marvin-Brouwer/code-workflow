import { describe, expect, test, vi } from 'vitest'
import { durationMs, wait } from '../src/wait/wait.mts'
import { runBody, type BodyRun } from './support/run-body.mts'

/** The first wake request the run sends. */
function firstWake(run: BodyRun) {
	return vi.waitFor(() => {
		const [asked] = run.channel.wakes
		if (asked === undefined) throw new Error('No wake asked yet.')
		return asked
	})
}

describe('wait', () => {
	test('asks the engine to wake it at the time, and resolves once it does', async () => {
		// Arrange
		const before = Date.now()
		const run = await runBody(() => wait({ seconds: 30 }))

		// Act
		const asked = await firstWake(run)
		run.channel.reply(asked.id, undefined)

		// Assert
		await expect(run.result).resolves.toBeUndefined()
		expect(asked.id).toBe('wake-1')
		const at = new Date(asked.at).getTime()
		expect(at).toBeGreaterThanOrEqual(before + 30_000)
		expect(at).toBeLessThan(before + 60_000)
		expect(run.channel.events.map((event) => event.type)).toEqual(['workflow', 'wait', 'wait-succeeded', 'workflow-succeeded'])
	})

	test('ends with the run when the run is stopped while it waits', async () => {
		// Arrange
		const run = await runBody(() => wait({ hours: 1 }))
		await firstWake(run)

		// Act
		run.controller.abort(new Error('Stopped.'))

		// Assert
		await expect(run.result).rejects.toThrow('Stopped.')
	})

	test('adds the fields up and refuses a negative duration', () => {
		// Arrange
		const spec = { hours: 1, minutes: 1, seconds: 1 }

		// Act
		const ms = durationMs(spec)

		// Assert
		expect(ms).toBe(3_661_000)
		expect(() => durationMs({ seconds: -1 })).toThrow('non-negative')
	})
})
