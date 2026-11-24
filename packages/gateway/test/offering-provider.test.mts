import { describe, expect, test } from 'vitest'
import { offeringProvider } from '../src/providers/offering-provider.mts'

describe('offeringProvider', () => {
	test('picks the first provider with a key that offers the model', () => {
		// Arrange
		const providers = [
			{ name: 'openai', kind: 'openai' },
			{ name: 'keyless', kind: 'anthropic' },
			{ name: 'second', kind: 'anthropic' },
			{ name: 'third', kind: 'anthropic' },
		]

		// Act
		const choice = offeringProvider(providers, ['claude-opus-5-5'], (provider) => provider !== 'keyless')

		// Assert
		expect(choice?.provider.name).toBe('second')
		expect(choice?.model.api).toBe('anthropic-messages')
	})

	test('goes by the order of the models before the order of the providers', () => {
		// Arrange
		const providers = [
			{ name: 'openai', kind: 'openai' },
			{ name: 'anthropic', kind: 'anthropic' },
		]

		// Act
		const choice = offeringProvider(providers, ['claude-opus-5-5', 'gpt-4o'], () => true)

		// Assert
		expect(choice?.provider.name).toBe('anthropic')
	})

	test('finds nothing when no provider with a key offers any of the models', () => {
		// Arrange
		const providers = [{ name: 'anthropic', kind: 'anthropic' }]

		// Act
		const choice = offeringProvider(providers, ['claude-opus-5-5', 'gpt-4o'], () => false)

		// Assert
		expect(choice).toBeUndefined()
	})
})
