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

	test('reads what an app declares', () => {
		// Act
		const message = RuntimeMessage.parse({
			type: 'described',
			description: {
				sandbox: { image: 'node:26-slim', cpus: 2, memoryMb: 2048, egress: { allow: [] } },
				workflows: [{ name: 'fix-issue', parameters: { type: 'object' } }],
				triggers: [
					{ kind: 'user', id: 'fix-issue', workflow: 'fix-issue' },
					{
						kind: 'webhook',
						id: 'fix-issue',
						workflow: 'fix-issue',
						payload: { type: 'object' },
						signature: { scheme: 'hmac-sha256', header: 'x-hub-signature-256', prefix: 'sha256=' },
					},
					{ kind: 'schedule', id: 'fix-issue 0 7 * * 1', workflow: 'fix-issue', cron: '0 7 * * 1', parameters: { issue: 1 } },
				],
			},
		})

		// Assert
		expect(message).toMatchObject({ type: 'described', description: { triggers: [{}, { kind: 'webhook' }, { cron: '0 7 * * 1' }] } })
	})

	test.each([
		[
			'a signature scheme it does not know',
			{
				type: 'described',
				description: {
					workflows: [],
					triggers: [{ kind: 'webhook', id: 'a', workflow: 'a', payload: {}, signature: { scheme: 'md5', header: 'x' } }],
				},
			},
		],
		['a skip without a reason', { type: 'skipped' }],
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
