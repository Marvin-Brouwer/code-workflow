import { describe, expect, test, vi } from 'vitest'
import { openEngineGatewayHome } from '../src/serve/engine-gateway.mts'
import { listProviderModels, listProviders, removeProviderKey, setProviderKey } from '../src/settings/providers.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

/** A provider that answers every request with `status`. */
function answering(status: number): typeof fetch {
	return () => Promise.resolve(new Response('', { status }))
}

/** A provider of Anthropic's kind, as a config declares it. */
const anthropic = { name: 'anthropic', kind: 'anthropic' }

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

	test('asks a provider for its models with its key, and says which ones agents can use', async () => {
		// Arrange
		const home = await gatewayHome()
		await setProviderKey(home, 'anthropic', 'sk-secret', abortSignal)
		const listed = vi.fn<typeof fetch>(() =>
			Promise.resolve(Response.json({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-unreleased' }] })),
		)

		// Act
		const models = await listProviderModels(home, [anthropic], 'anthropic', abortSignal, listed)

		// Assert
		const [url, init] = listed.mock.calls[0] ?? []
		expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000')
		expect(init?.headers).toMatchObject({ 'x-api-key': 'sk-secret' })
		expect(models).toEqual({
			source: 'provider',
			models: [
				{ id: 'claude-opus-5-5', usable: true },
				{ id: 'claude-unreleased', usable: false },
			],
		})
	})

	test("lists pi-ai's models of the kind when the provider has no model list, and says why when it didn't list them", async () => {
		// Arrange
		const home = await gatewayHome()
		await setProviderKey(home, 'anthropic', 'sk-secret', abortSignal)

		// Act
		const noList = await listProviderModels(home, [anthropic], 'anthropic', abortSignal, answering(404))
		const refused = await listProviderModels(home, [anthropic], 'anthropic', abortSignal, answering(401))

		// Assert
		expect(noList).toMatchObject({
			source: 'catalog',
			models: expect.arrayContaining([{ id: 'claude-opus-5-5', usable: true }]) as unknown,
		})
		expect(refused).toEqual({ source: 'failed', reason: "Provider anthropic didn't list its models: it answered 401." })
	})

	test("doesn't ask a provider without a key, or one the config doesn't declare", async () => {
		// Arrange
		const home = await gatewayHome()
		const listed = vi.fn<typeof fetch>()

		// Act
		const keyless = await listProviderModels(home, [anthropic], 'anthropic', abortSignal, listed).catch((error: unknown) => error)
		const undeclared = await listProviderModels(home, [anthropic], 'openai', abortSignal, listed).catch((error: unknown) => error)

		// Assert
		expect(keyless).toMatchObject({ code: 'invalid' })
		expect(undeclared).toMatchObject({ code: 'not-found' })
		expect(listed).not.toHaveBeenCalled()
	})
})
