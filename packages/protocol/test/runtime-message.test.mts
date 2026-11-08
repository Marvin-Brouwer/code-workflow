import { describe, expect, test } from 'vitest'
import { RuntimeMessage } from '../src/runtime-message.mts'

describe('RuntimeMessage', () => {
	test('keeps the fields of an event it does not know', () => {
		// Act
		const message = RuntimeMessage.parse({
			type: 'event',
			event: { id: '2', parentId: '1', type: 'log', at: '2026-11-08T08:00:00Z', line: 'hi' },
		})

		// Assert
		expect(message).toMatchObject({ event: { line: 'hi' } })
	})

	test.each([
		['an unknown type', { type: 'shrug' }],
		['a request id that cannot be a file name', { type: 'request', request: { kind: 'wake', id: '../x', at: '2026-11-08T08:00:00Z' } }],
		['a wake without a time', { type: 'request', request: { kind: 'wake', id: 'later', at: 'tomorrow' } }],
		['a failure without an error', { type: 'failed' }],
	])('refuses %s', (_name, value) => {
		// Act
		const parsed = RuntimeMessage.safeParse(value)

		// Assert
		expect(parsed.success).toBe(false)
	})
})
