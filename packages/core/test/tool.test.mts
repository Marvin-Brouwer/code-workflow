import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { tool, ToolInputError } from '../src/tool/tool.mts'

const abortSignal = new AbortController().signal

describe('tool', () => {
	test('is a function code can call, outside a run with an abort signal', async () => {
		// Arrange
		const search = tool('search', { input: z.object({ query: z.string() }), action: async ({ query }) => [query] })

		// Act
		const result = await search({ query: 'login' }, { abortSignal })

		// Assert
		expect(result).toEqual(['login'])
		expect(search.name).toBe('search')
	})

	test('throws when the input does not fit', async () => {
		// Arrange
		const search = tool('search', { input: z.object({ query: z.string() }), action: async () => [] })

		// Act
		// @ts-expect-error -- the wrong input type is the point
		const calling = search({ query: 1 }, { abortSignal })

		// Assert
		await expect(calling).rejects.toThrow(ToolInputError)
	})

	test('rejects once with the reason of a stop that came before the call, also when the action sees the stop itself', async () => {
		// Arrange
		const stopped = AbortSignal.abort(new Error('The run stopped.'))
		const record = tool('record', {
			input: z.object({}),
			action: async (_input, context) => {
				context.abortSignal.throwIfAborted()
				return 'recorded'
			},
		})

		// Act
		const calling = record({}, { abortSignal: stopped })

		// Assert
		await expect(calling).rejects.toThrow('The run stopped.')
	})

	test('refuses a call outside a run without an abort signal', async () => {
		// Arrange
		const search = tool('search', { input: z.object({}), action: async () => [] })

		// Act
		const calling = search({})

		// Assert
		await expect(calling).rejects.toThrow('pass { abortSignal }')
	})

	test('refuses a name a model provider would not take', () => {
		// Act and assert
		expect(() => tool('jira search', { input: z.object({}), action: async () => [] })).toThrow('Tool name')
	})
})
