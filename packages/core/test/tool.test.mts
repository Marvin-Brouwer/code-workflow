import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { tool, ToolInputError } from '../src/tool/tool.mts'

const signal = new AbortController().signal

describe('tool', () => {
	test('is a function code can call, outside a run with a signal', async () => {
		// Arrange
		const search = tool('search', { input: z.object({ query: z.string() }), action: async ({ query }) => [query] })

		// Act
		const result = await search({ query: 'login' }, { signal })

		// Assert
		expect(result).toEqual(['login'])
		expect(search.name).toBe('search')
	})

	test('throws when the input does not fit', async () => {
		// Arrange
		const search = tool('search', { input: z.object({ query: z.string() }), action: async () => [] })

		// Act
		// @ts-expect-error -- the wrong input type is the point
		const calling = search({ query: 1 }, { signal })

		// Assert
		await expect(calling).rejects.toThrow(ToolInputError)
	})

	test('refuses a call outside a run without a signal', async () => {
		// Arrange
		const search = tool('search', { input: z.object({}), action: async () => [] })

		// Act
		const calling = search({})

		// Assert
		await expect(calling).rejects.toThrow('pass { signal }')
	})

	test('refuses a name a model provider would not take', () => {
		// Act and assert
		expect(() => tool('jira search', { input: z.object({}), action: async () => [] })).toThrow('Tool name')
	})
})
