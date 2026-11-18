import { describe, expect, test, vi } from 'vitest'
import { duration } from '@mesh-flow/duration'
import { wait } from '../src/wait/wait.mts'
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
		const before = new Date()
		const run = await runBody(() => wait(duration.of('30s')))

		// Act
		const asked = await firstWake(run)
		run.channel.reply(asked.id, undefined)

		// Assert
		await expect(run.result).resolves.toBeUndefined()
		expect(asked.id).toBe('wake-1')
		const at = new Date(asked.at)
		expect(at >= duration.of('30s').after(before)).toBe(true)
		expect(at < duration.of('1m').after(before)).toBe(true)
		expect(run.channel.events.map((event) => event.type)).toEqual(['workflow', 'wait', 'wait-succeeded', 'workflow-succeeded'])
	})

	test('ends with the run when the run is stopped while it waits', async () => {
		// Arrange
		const run = await runBody(() => wait(duration.of('1h')))
		await firstWake(run)

		// Act
		run.controller.abort(new Error('Stopped.'))

		// Assert
		await expect(run.result).rejects.toThrow('Stopped.')
	})
})
