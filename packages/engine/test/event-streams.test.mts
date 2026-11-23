import { duration } from '@mesh-flow/duration'
import type { RuntimeEvent } from '@mesh-flow/protocol'
import { Hono } from 'hono'
import { describe, expect, test, vi } from 'vitest'
import { engineEvents } from '../src/control/engine-events.mts'
import { runEventStream } from '../src/control/run-events.mts'
import type { RunId } from '../src/runs/run-id.mts'
import type { RunRecord } from '../src/runs/run-record.mts'

/** Listeners a test calls, and that say when they stopped. */
function listeners<Value>() {
	const added: { listener: (value: Value) => void; abortSignal: AbortSignal }[] = []
	return {
		listen: (listener: (value: Value) => void, abortSignal: AbortSignal) => {
			added.push({ listener, abortSignal })
		},
		call: (value: Value) => {
			for (const { listener, abortSignal } of added) if (!abortSignal.aborted) listener(value)
		},
		listening: () => added.some(({ abortSignal }) => !abortSignal.aborted),
	}
}

/** Reads server-sent events from `reader` until `count` of them came, heartbeats left out. */
async function readEvents(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<string[]> {
	const decoder = new TextDecoder()
	let text = ''
	const events = () =>
		text
			.split('\n\n')
			.slice(0, -1)
			.filter((event) => !event.startsWith('event: heartbeat'))
	while (events().length < count) {
		const { value, done } = await reader.read()
		if (done) break
		text += decoder.decode(value, { stream: true })
	}
	return events().slice(0, count)
}

/** Reads what comes from `reader` until `enough` says it is. */
async function readAllUntil(reader: ReadableStreamDefaultReader<Uint8Array>, enough: (text: string) => boolean): Promise<string> {
	const decoder = new TextDecoder()
	let text = ''
	while (!enough(text)) {
		const { value, done } = await reader.read()
		if (done) break
		text += decoder.decode(value, { stream: true })
	}
	return text
}

function readerOf(response: Response): ReadableStreamDefaultReader<Uint8Array> {
	const reader = response.body?.getReader()
	if (reader === undefined) throw new Error('The stream has no body.')
	return reader
}

const runId: RunId = 'run-000000000001'

function runRecord(status: RunRecord['status']): RunRecord {
	return {
		id: runId,
		workflow: 'report',
		trigger: { kind: 'user', id: 'report' },
		app: {
			name: 'reports',
			version: 'v1',
			entry: 'main.mjs',
			sandbox: { image: 'node:26', cpus: 1, memoryMb: 512 },
			tools: [],
			registries: [],
		},
		status,
		cursor: 0,
		pending: [],
		createdAt: '2026-11-23T08:00:00.000Z',
		updatedAt: '2026-11-23T08:00:00.000Z',
	}
}

function runEvent(id: string): RuntimeEvent {
	return { id, type: 'note', at: '2026-11-23T08:00:00.000Z' }
}

/** A run that a test changes, with the stream route over it. */
function followedRun() {
	const changes = listeners<RunId>()
	let record: RunRecord | undefined = runRecord('running')
	const events: RuntimeEvent[] = [runEvent('a')]
	const source = {
		get: (id: string) => {
			if (id !== runId || record === undefined) throw new Error(`There is no run ${id}.`)
			return record
		},
		events: () => Promise.resolve([...events]),
		onRunChange: changes.listen,
	}
	const follow = runEventStream(source, duration.of('1h'))
	const app = new Hono()
		.get('/runs/:run/events', (context) => follow(context, context.req.param('run')))
		.onError((error, context) => context.text(error.message, 404))
	return {
		app,
		changes,
		addEvent: (event: RuntimeEvent) => {
			events.push(event)
			changes.call(runId)
		},
		setStatus: (status: RunRecord['status']) => {
			record = runRecord(status)
			changes.call(runId)
		},
		remove: () => {
			record = undefined
			changes.call(runId)
		},
	}
}

describe('engineEvents', () => {
	test('says it is ready, then which run or sign-in changed, with a heartbeat between', async () => {
		// Arrange
		const runs = listeners<RunId>()
		const signIns = listeners<string>()
		const app = new Hono().get('/events', engineEvents({ onRunChange: runs.listen, onSignInChange: signIns.listen }, duration.of('50ms')))
		const response = await app.request('/events')
		const reader = readerOf(response)

		// Act
		const [ready] = await readEvents(reader, 1)
		runs.call(runId)
		signIns.call('cloud')
		const later = await readAllUntil(reader, (text) => text.includes('event: heartbeat'))
		await reader.cancel()

		// Assert
		expect(response.headers.get('content-type')).toBe('text/event-stream')
		expect(ready).toBe('event: ready\ndata: {}')
		expect(later).toContain(`event: run\ndata: {"id":"${runId}"}\n\nevent: sign-in\ndata: {"connector":"cloud"}`)
	})

	test('stops listening when the reader goes away', async () => {
		// Arrange
		const runs = listeners<RunId>()
		const signIns = listeners<string>()
		const app = new Hono().get('/events', engineEvents({ onRunChange: runs.listen, onSignInChange: signIns.listen }, duration.of('1h')))
		const reader = readerOf(await app.request('/events'))
		await readEvents(reader, 1)

		// Act
		await reader.cancel()

		// Assert
		await vi.waitFor(() => {
			expect(runs.listening()).toBe(false)
			expect(signIns.listening()).toBe(false)
		})
	})
})

describe('runEventStream', () => {
	test('sends the events and the record so far, then each new event and the record when it changes', async () => {
		// Arrange
		const run = followedRun()
		const reader = readerOf(await run.app.request(`/runs/${runId}/events`))

		// Act
		const first = await readEvents(reader, 2)
		run.addEvent(runEvent('b'))
		run.setStatus('succeeded')
		const later = await readEvents(reader, 2)
		await reader.cancel()

		// Assert
		expect(first).toEqual([
			`event: event\ndata: ${JSON.stringify(runEvent('a'))}\nid: 1`,
			`event: run\ndata: ${JSON.stringify(runRecord('running'))}`,
		])
		expect(later).toEqual([
			`event: event\ndata: ${JSON.stringify(runEvent('b'))}\nid: 2`,
			`event: run\ndata: ${JSON.stringify(runRecord('succeeded'))}`,
		])
	})

	test('sends only the events after Last-Event-ID to a reader that connects again', async () => {
		// Arrange
		const run = followedRun()
		run.addEvent(runEvent('b'))

		// Act
		const reader = readerOf(await run.app.request(`/runs/${runId}/events`, { headers: { 'last-event-id': '1' } }))
		const sent = await readEvents(reader, 2)
		await reader.cancel()

		// Assert
		expect(sent).toEqual([
			`event: event\ndata: ${JSON.stringify(runEvent('b'))}\nid: 2`,
			`event: run\ndata: ${JSON.stringify(runRecord('running'))}`,
		])
	})

	test('answers a run there is none of before it streams', async () => {
		// Arrange
		const run = followedRun()

		// Act
		const response = await run.app.request('/runs/run-000000000002/events')

		// Assert
		expect(response.status).toBe(404)
	})

	test('ends the stream, and stops listening, once the run is removed', async () => {
		// Arrange
		const run = followedRun()
		const reader = readerOf(await run.app.request(`/runs/${runId}/events`))
		await readEvents(reader, 2)

		// Act
		run.remove()
		const ended = await reader.read().then(async function rest(result): Promise<boolean> {
			return result.done ? true : rest(await reader.read())
		})

		// Assert
		expect(ended).toBe(true)
		expect(run.changes.listening()).toBe(false)
	})
})
