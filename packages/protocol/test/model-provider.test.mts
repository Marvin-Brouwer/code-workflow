import { describe, expect, test } from 'vitest'
import { ModelProviderDescription } from '../src/model-provider.mts'

describe('ModelProviderDescription', () => {
	test.each([
		['a known kind', { kind: 'anthropic', name: 'anthropic' }],
		['a compatible server with a base URL', { kind: 'openai-compatible', name: 'team-litellm', baseUrl: 'https://litellm.example.com/v1' }],
	])('accepts %s', (_case, provider) => {
		// Act
		const parsed = ModelProviderDescription.safeParse(provider)

		// Assert
		expect(parsed.success).toBe(true)
	})

	test('rejects a compatible server without a base URL', () => {
		// Act
		const parsed = ModelProviderDescription.safeParse({ kind: 'openai-compatible', name: 'team-litellm' })

		// Assert
		expect(parsed.success).toBe(false)
	})
})
