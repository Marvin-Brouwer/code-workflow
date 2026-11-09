import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { openProviderSettings } from '../src/providers/provider-settings.mts'
import { resolveModel } from '../src/providers/resolve-model.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

async function settings() {
	return openProviderSettings(path.join(await temporaryDirectory(), 'providers.json'))
}

describe('openProviderSettings', () => {
	test('adds providers in order and replaces one in place', async () => {
		// Arrange
		const providers = await settings()
		await providers.put({ name: 'anthropic', kind: 'anthropic' }, abortSignal)
		await providers.put({ name: 'router', kind: 'openrouter' }, abortSignal)

		// Act
		await providers.put({ name: 'anthropic', kind: 'anthropic', baseUrl: 'https://proxy.example.com' }, abortSignal)

		// Assert
		expect(await providers.list(abortSignal)).toEqual([
			{ name: 'anthropic', kind: 'anthropic', baseUrl: 'https://proxy.example.com', owner: 'user' },
			{ name: 'router', kind: 'openrouter', owner: 'user' },
		])
	})

	test('orders them when every provider is named once', async () => {
		// Arrange
		const providers = await settings()
		await providers.put({ name: 'a', kind: 'anthropic' }, abortSignal)
		await providers.put({ name: 'b', kind: 'openai' }, abortSignal)

		// Act
		await providers.order(['b', 'a'], abortSignal)

		// Assert
		expect((await providers.list(abortSignal)).map((provider) => provider.name)).toEqual(['b', 'a'])
	})

	test('refuses an order that leaves a provider out', async () => {
		// Arrange
		const providers = await settings()
		await providers.put({ name: 'a', kind: 'anthropic' }, abortSignal)
		await providers.put({ name: 'b', kind: 'openai' }, abortSignal)

		// Act
		const ordering = providers.order(['b'], abortSignal)

		// Assert
		await expect(ordering).rejects.toThrow('Name every provider once')
	})
})

describe('resolveModel', () => {
	test('picks the first provider that offers the model', async () => {
		// Arrange
		const providers = await settings()
		await providers.put({ name: 'openai', kind: 'openai' }, abortSignal)
		await providers.put({ name: 'second', kind: 'anthropic' }, abortSignal)
		await providers.put({ name: 'third', kind: 'anthropic' }, abortSignal)

		// Act
		const choice = resolveModel(await providers.list(abortSignal), 'claude-opus-5-5')

		// Assert
		expect(choice.provider.name).toBe('second')
		expect(choice.model.api).toBe('anthropic-messages')
	})

	test('says which providers there are when none offers the model', async () => {
		// Arrange
		const providers = await settings()
		await providers.put({ name: 'openai', kind: 'openai' }, abortSignal)

		// Act
		const resolving = async () => resolveModel(await providers.list(abortSignal), 'claude-opus-5-5')

		// Assert
		await expect(resolving()).rejects.toThrow('None of the providers (openai) offers model claude-opus-5-5')
	})
})
