import { describe, expect, test, vi } from 'vitest'
import { duration } from '@mesh-flow/duration'
import { poll } from '../src/wait/poll.mts'
import { wait } from '../src/wait/wait.mts'
import { runBody } from './support/run-body.mts'

describe('poll', () => {
	test('puts the look in a poll event that says what is waited for', async () => {
		// Arrange
		const description = 'review of octo/dice#12'
		const run = await runBody(async () => {
			const found = await poll(description, async () => 'open')
			await poll(description, () => wait(duration.of('10s')))
			return found
		})

		// Act
		const asked = await vi.waitFor(() => {
			const [wake] = run.channel.wakes
			if (wake === undefined) throw new Error('No wake asked yet.')
			return wake
		})
		run.channel.reply(asked.id, undefined)

		// Assert
		await expect(run.result).resolves.toBe('open')
		expect(run.channel.events.map((event) => event.type)).toEqual([
			'workflow',
			'poll',
			'poll-succeeded',
			'poll',
			'wait',
			'wait-succeeded',
			'poll-succeeded',
			'workflow-succeeded',
		])
		expect(run.channel.events.filter((event) => event.type === 'poll').map((event) => event.description)).toEqual([
			description,
			description,
		])
	})

	test('ends with the run when the run is stopped while it waits', async () => {
		// Arrange
		const run = await runBody(() => poll('merge', () => wait(duration.of('1h'))))
		await vi.waitFor(() => {
			if (run.channel.wakes.length === 0) throw new Error('No wake asked yet.')
		})

		// Act
		run.controller.abort(new Error('Stopped.'))

		// Assert
		await expect(run.result).rejects.toThrow('Stopped.')
		expect(run.channel.events.map((event) => event.type)).toContain('poll-failed')
	})

	test('ends with the run when the run is stopped while a look never settles', async () => {
		// Arrange
		const looked = Promise.withResolvers<undefined>()
		const run = await runBody(() =>
			poll('merge', async () => {
				looked.resolve(undefined)
				return new Promise<never>(() => undefined)
			}),
		)
		await looked.promise

		// Act
		run.controller.abort(new Error('Stopped.'))

		// Assert
		await expect(run.result).rejects.toThrow('Stopped.')
		expect(run.channel.events.map((event) => event.type)).toContain('poll-failed')
	})
})
