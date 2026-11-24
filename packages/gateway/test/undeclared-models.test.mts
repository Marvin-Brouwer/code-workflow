import { describe, expect, test } from 'vitest'
import { undeclaredModels } from '../src/providers/undeclared-models.mts'

describe('undeclaredModels', () => {
	test('is empty when a declared provider offers every model of every agent', () => {
		// Arrange
		const providers = [
			{ name: 'anthropic', kind: 'anthropic' },
			{ name: 'openai', kind: 'openai' },
		]

		// Act
		const problems = undeclaredModels(providers, [['claude-opus-5-5', 'gpt-4o'], ['claude-sonnet-5-5']])

		// Assert
		expect(problems).toEqual([])
	})

	test('names each fallback model no declared provider offers, once', () => {
		// Arrange
		const providers = [{ name: 'anthropic', kind: 'anthropic' }]

		// Act
		const problems = undeclaredModels(providers, [['claude-opus-5-5', 'gpt-4o'], ['gpt-4o']])

		// Assert
		expect(problems).toEqual(["Model gpt-4o isn't offered by any provider in the config (anthropic)."])
	})

	test("counts a compatible server as offering every model: it's only asked when a loop starts", () => {
		// Arrange
		const providers = [{ name: 'team-litellm', kind: 'openai-compatible', baseUrl: 'https://litellm.example.com/v1' }]

		// Act
		const problems = undeclaredModels(providers, [['team-model'], ['claude-opus-5-5']])

		// Assert
		expect(problems).toEqual([])
	})

	test('says to declare a provider when the config has none', () => {
		// Act
		const problems = undeclaredModels([], [['claude-opus-5-5']])

		// Assert
		expect(problems).toEqual([
			"Model claude-opus-5-5 isn't offered by any provider in the config: it declares none. Add one to `modelProviders` in `defineMeshFlow`.",
		])
	})

	test('names a provider kind the gateway has no model calls for', () => {
		// Arrange
		const providers = [{ name: 'mine', kind: 'no-such-kind' }]

		// Act
		const problems = undeclaredModels(providers, [])

		// Assert
		expect(problems).toEqual([
			"The gateway can't send model calls for provider kind no-such-kind (provider mine). See `mesh-flow provider kinds`.",
		])
	})
})
