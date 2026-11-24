import { describe, expect, test } from 'vitest'
import { ModelProviderDescription } from '../src/model-provider.mts'

/** A model of a compatible server. */
const model = {
	id: 'team-model',
	contextWindow: 128_000,
	maxTokens: 16_384,
	reasoning: false,
}

describe('ModelProviderDescription', () => {
	test.each([
		['a known kind without models', { kind: 'anthropic', name: 'anthropic' }],
		[
			'a compatible server with a base URL and models',
			{ kind: 'openai-compatible', name: 'team-litellm', baseUrl: 'https://litellm.example.com/v1', models: [model] },
		],
	])('accepts %s', (_case, provider) => {
		// Act
		const parsed = ModelProviderDescription.safeParse(provider)

		// Assert
		expect(parsed.success).toBe(true)
	})

	test.each([
		['a compatible server without models', { kind: 'openai-compatible', name: 'team-litellm', baseUrl: 'https://litellm.example.com/v1' }],
		['a compatible server without a base URL', { kind: 'openai-compatible', name: 'team-litellm', models: [model] }],
		['a known kind with models', { kind: 'anthropic', name: 'anthropic', models: [model] }],
	])('rejects %s', (_case, provider) => {
		// Act
		const parsed = ModelProviderDescription.safeParse(provider)

		// Assert
		expect(parsed.success).toBe(false)
	})
})
