import { duration } from '@mesh-flow/duration'
import { Hono } from 'hono'
import { describe, expect, test, vi } from 'vitest'
import { changeStream } from '../src/control/change-stream.mts'
import type { RunId } from '../src/runs/run-id.mts'

/** A change source that a test changes runs of, and that says when its listener stopped. */
function changeSource() {
	const listeners: { listener: (run: RunId) => void; abortSignal: AbortSignal }[] = []
	return {
		onRunChange: (listener: (run: RunId) => void, abortSignal: AbortSignal) => {
			listeners.push({ listener, abortSignal })
		},
		change: (run: RunId) => {
			for (const { listener, abortSignal } of listeners) if (!abortSignal.aborted) listener(run)
		},
		listening: () => listeners.some(({ abortSignal }) => !abortSignal.aborted),
	}
}

/** Reads server-sent events from `body` until `count` of them came. */
async function readEvents(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<string[]> {
	const decoder = new TextDecoder()
	let text = ''
	while (text.split('\n\n').length <= count) {
		const { value, done } = await reader.read()
		if (done) break
		text += decoder.decode(value, { stream: true })
	}
	return text.split('\n\n').slice(0, count)
}

describe('changeStream', () => {
	test('says it is ready, then which run changed, with a heartbeat between', async () => {
		// Arrange
		const source = changeSource()
		const app = new Hono().get('/changes', changeStream(source, duration.of('50ms')))
		const response = await app.request('/changes')
		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('The stream has no body.')

		// Act
		const [ready] = await readEvents(reader, 1)
		source.change('run-000000000001')
		// A heartbeat may come before the change or after it, and more may come between.
		const later = await readEvents(reader, 3)
		await reader.cancel()

		// Assert
		expect(response.headers.get('content-type')).toBe('text/event-stream')
		expect(ready).toBe('event: ready\ndata: {}')
		expect(later).toEqual(expect.arrayContaining(['event: run\ndata: {"id":"run-000000000001"}', 'event: heartbeat\ndata: {}']))
	})

	test('stops listening when the reader goes away', async () => {
		// Arrange
		const source = changeSource()
		const app = new Hono().get('/changes', changeStream(source, duration.of('1h')))
		const response = await app.request('/changes')
		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('The stream has no body.')
		await readEvents(reader, 1)

		// Act
		await reader.cancel()

		// Assert
		await vi.waitFor(() => {
			expect(source.listening()).toBe(false)
		})
	})
})
