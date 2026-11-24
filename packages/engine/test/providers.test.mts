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
		await setProviderKey(home, declared, 'anthropic', 'sk-secret', abortSignal)

		// Act
		const listed = await listProviders(home, declared, abortSignal)

		// Assert
		expect(listed).toEqual([
			{ name: 'proxy', kind: 'openrouter', baseUrl: 'https://llm-proxy.example.com/api/v1', hasKey: false },
			{ name: 'anthropic', kind: 'anthropic', hasKey: true },
		])
	})

	test('shows a key as not set, and where it was set for, once the config sends the provider elsewhere', async () => {
		// Arrange
		const home = await gatewayHome()
		const proxy = { name: 'proxy', kind: 'openrouter', baseUrl: 'https://llm-proxy.example.com/api/v1' }
		await setProviderKey(home, [proxy], 'proxy', 'sk-secret', abortSignal)
		const moved = { ...proxy, baseUrl: 'https://elsewhere.example.com/api/v1' }

		// Act
		const listed = await listProviders(home, [moved], abortSignal)

		// Assert
		expect(listed).toEqual([{ ...moved, hasKey: false, keySetFor: 'https://llm-proxy.example.com' }])
	})

	test('lists a provider without an origin, and a key stored without one, as having no key', async () => {
		// Arrange
		const home = await gatewayHome()
		await home.credentials.set('provider/anthropic', 'sk-secret', abortSignal)
		const declared = [anthropic, { name: 'azure', kind: 'azure' }]

		// Act
		const listed = await listProviders(home, declared, abortSignal)

		// Assert
		expect(listed).toEqual([
			{ ...anthropic, hasKey: false },
			{ name: 'azure', kind: 'azure', hasKey: false },
		])
	})

	test('refuses a key for a provider without an origin to tie it to', async () => {
		// Arrange
		const home = await gatewayHome()
		const azure = { name: 'azure', kind: 'azure' }

		// Act
		const setting = setProviderKey(home, [azure], 'azure', 'sk-secret', abortSignal)

		// Assert
		await expect(setting).rejects.toMatchObject({
			code: 'invalid',
			message: 'Provider azure has no base URL to tie its key to: give it a `baseUrl` in `modelProviders`.',
		})
	})

	test("refuses a key for a provider the config doesn't declare", async () => {
		// Arrange
		const home = await gatewayHome()

		// Act
		const setting = setProviderKey(home, [anthropic], 'openai', 'sk-secret', abortSignal)

		// Assert
		await expect(setting).rejects.toMatchObject({ code: 'not-found' })
	})

	test("removes a provider's key, and says so when it had none", async () => {
		// Arrange
		const home = await gatewayHome()
		await setProviderKey(home, [anthropic], 'anthropic', 'sk-secret', abortSignal)

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
		const setting = setProviderKey(home, [anthropic], '../webhook/x', 'sk-secret', abortSignal)

		// Assert
		await expect(setting).rejects.toMatchObject({ code: 'invalid' })
	})

	test('asks a provider for its models with its key, and says which ones agents can use', async () => {
		// Arrange
		const home = await gatewayHome()
		await setProviderKey(home, [anthropic], 'anthropic', 'sk-secret', abortSignal)
		const fetchFromHost = vi.fn<typeof fetch>(() =>
			Promise.resolve(Response.json({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-unreleased' }] })),
		)

		// Act
		const models = await listProviderModels(home, [anthropic], 'anthropic', abortSignal, fetchFromHost)

		// Assert
		const [url, init] = fetchFromHost.mock.calls[0] ?? []
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

	test("lists pi-ai's models of the kind when the provider has no model list", async () => {
		// Arrange
		const home = await gatewayHome()
		await setProviderKey(home, [anthropic], 'anthropic', 'sk-secret', abortSignal)

		// Act
		const models = await listProviderModels(home, [anthropic], 'anthropic', abortSignal, answering(404))

		// Assert
		expect(models).toMatchObject({
			source: 'catalog',
			models: expect.arrayContaining([{ id: 'claude-opus-5-5', usable: true }]) as unknown,
		})
	})

	test("says why a provider didn't list its models", async () => {
		// Arrange
		const home = await gatewayHome()
		await setProviderKey(home, [anthropic], 'anthropic', 'sk-secret', abortSignal)

		// Act
		const models = await listProviderModels(home, [anthropic], 'anthropic', abortSignal, answering(401))

		// Assert
		expect(models).toEqual({ source: 'failed', reason: "Provider anthropic didn't list its models: it answered 401." })
	})

	test.each([
		['without a key', 'anthropic', 'invalid'],
		["the config doesn't declare", 'openai', 'not-found'],
	])("doesn't ask a provider %s", async (_case, name, code) => {
		// Arrange
		const home = await gatewayHome()
		const fetchFromHost = vi.fn<typeof fetch>()

		// Act
		const refused = await listProviderModels(home, [anthropic], name, abortSignal, fetchFromHost).catch((error: unknown) => error)

		// Assert
		expect(refused).toMatchObject({ code })
		expect(fetchFromHost).not.toHaveBeenCalled()
	})
})
