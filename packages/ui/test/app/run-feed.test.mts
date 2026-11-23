import { describe, expect, test } from 'vitest'
import type { RunEvent, RunRecord } from '../../app/src/_shared/runs.mts'
import { runFeed } from '../../app/src/runs/run-feed.mts'
import { shownAnswer } from '../../app/src/runs/shown-answer.mts'

const at = '2026-11-23T08:00:00.000Z'

function event(id: string): RunEvent {
	return { id, type: 'note', at }
}

const record: RunRecord = {
	id: 'run-000000000001',
	workflow: 'fix-issue',
	trigger: { kind: 'user', id: 'fix-issue' },
	app: { name: 'github-issue', version: '1' },
	status: 'running',
	pending: [],
	createdAt: at,
	updatedAt: at,
}

describe('runFeed', () => {
	test('drops a fetch that started before the stream connected again, so it loses no streamed events', () => {
		// Arrange
		const feed = runFeed()
		const started = feed.fetchStarted()
		feed.connected()
		for (const id of ['1-1', '1-2', '1-3']) feed.streamedEvent(event(id))

		// Act
		const taken = feed.fetched(started, { record, events: [event('1-1')] })
		feed.streamedEvent(event('1-4'))

		// Assert
		expect(taken).toBe(false)
		expect(feed.snapshot().events.map(({ id }) => id)).toEqual(['1-1', '1-2', '1-3', '1-4'])
	})

	test('takes a fetch while the stream stays down, and starts over when it connects', () => {
		// Arrange
		const feed = runFeed()
		feed.fetched(feed.fetchStarted(), { record, events: [event('1-1'), event('1-2')] })

		// Act
		feed.connected()
		feed.streamedEvent(event('1-1'))

		// Assert
		expect(feed.snapshot().events.map(({ id }) => id)).toEqual(['1-1'])
	})
})

describe('shownAnswer', () => {
	test.each([404, 409])('says a question answered elsewhere was, for %i', (status) => {
		// Act
		const shown = shownAnswer({ ok: false, error: 'Run run-000000000001 does not wait for input input-1.', status })

		// Assert
		expect(shown).toEqual({ ok: false, error: 'This was answered elsewhere, in another tab or with the CLI.', status })
	})

	test('leaves any other refusal as it is', () => {
		// Act
		const shown = shownAnswer({ ok: false, error: 'The answer does not fit.', status: 400 })

		// Assert
		expect(shown).toEqual({ ok: false, error: 'The answer does not fit.', status: 400 })
	})
})
