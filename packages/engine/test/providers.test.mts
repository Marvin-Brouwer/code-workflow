import { describe, expect, test } from 'vitest'
import { openEngineGatewayHome } from '../src/serve/engine-gateway.mts'
import { listProviders, removeProviderKey, setProviderKey } from '../src/settings/providers.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

async function gatewayHome() {
	return openEngineGatewayHome(await temporaryDirectory(), abortSignal, { keychain: false })
}

describe('the provider settings', () => {
	test("lists the config's providers in their order, with whether each has a key", async () => {
		// Arrange
		const home = await gatewayHome()
		const declared = [
			{ name: 'proxy', kind: 'openrouter', baseUrl: 'https://llm-proxy.example.com/api/v1' },
			{ name: 'anthropic', kind: 'anthropic' },
		]
		await setProviderKey(home, 'anthropic', 'sk-secret', abortSignal)

		// Act
		const listed = await listProviders(home, declared, abortSignal)

		// Assert
		expect(listed).toEqual([
			{ name: 'proxy', kind: 'openrouter', baseUrl: 'https://llm-proxy.example.com/api/v1', hasKey: false },
			{ name: 'anthropic', kind: 'anthropic', hasKey: true },
		])
	})

	test("removes a provider's key, and says so when it had none", async () => {
		// Arrange
		const home = await gatewayHome()
		await setProviderKey(home, 'anthropic', 'sk-secret', abortSignal)

		// Act
		await removeProviderKey(home, 'anthropic', abortSignal)
		const again = removeProviderKey(home, 'anthropic', abortSignal)

		// Assert
		expect(await home.credentials.names(abortSignal)).toEqual([])
		await expect(again).rejects.toMatchObject({ code: 'not-found' })
	})

	test("refuses a key for a name that can't be a provider's", async () => {
		// Arrange
		const home = await gatewayHome()

		// Act
		const setting = setProviderKey(home, '../webhook/x', 'sk-secret', abortSignal)

		// Assert
		await expect(setting).rejects.toMatchObject({ code: 'invalid' })
	})
})
