import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { openCredentialStore } from '../src/credentials/credential-store.mts'
import { keyFile } from '../src/credentials/store-key.mts'
import { providerCredential } from '../src/providers/provider-credential.mts'
import { providerKeyOf, providerOrigin, storeProviderKey } from '../src/providers/provider-key.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

const proxy = { name: 'proxy', kind: 'openrouter', baseUrl: 'https://llm-proxy.example.com/api/v1' }

async function credentialStore() {
	const home = await temporaryDirectory()
	return openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
}

describe('providerOrigin', () => {
	test.each([
		['its base URL', proxy, 'https://llm-proxy.example.com'],
		["its kind's", { name: 'anthropic', kind: 'anthropic' }, 'https://api.anthropic.com'],
		["nothing for a kind the gateway doesn't know", { name: 'odd', kind: 'unknown-kind' }, undefined],
		['nothing for a kind whose base URL the config has to give', { name: 'azure', kind: 'azure' }, undefined],
		["nothing for a base URL that isn't a web one", { name: 'odd', kind: 'openai-compatible', baseUrl: 'foo://server/v1' }, undefined],
	])('is the origin of %s', (_case, provider, origin) => {
		// Act
		const found = providerOrigin(provider)

		// Assert
		expect(found).toBe(origin)
	})
})

describe('providerKeyOf', () => {
	test('gives the key for the origin it was set for, whatever the path', async () => {
		// Arrange
		const credentials = await credentialStore()
		await storeProviderKey(credentials, proxy, 'sk-secret', abortSignal)

		// Act
		const key = await providerKeyOf(credentials, { ...proxy, baseUrl: 'https://llm-proxy.example.com/v2' }, abortSignal)

		// Assert
		expect(key).toEqual({ status: 'set', key: 'sk-secret' })
	})

	test('keeps the key from a provider the config sends elsewhere, and says where it was set for', async () => {
		// Arrange
		const credentials = await credentialStore()
		await storeProviderKey(credentials, proxy, 'sk-secret', abortSignal)

		// Act
		const key = await providerKeyOf(credentials, { ...proxy, baseUrl: 'https://elsewhere.example.com/api/v1' }, abortSignal)

		// Assert
		expect(key).toEqual({ status: 'elsewhere', origin: 'https://llm-proxy.example.com' })
	})

	test.each([
		['no key', undefined],
		["a key that wasn't set for an origin", 'sk-secret'],
	])('counts %s as missing', async (_case, stored) => {
		// Arrange
		const credentials = await credentialStore()
		if (stored !== undefined) await credentials.set(providerCredential(proxy.name), stored, abortSignal)

		// Act
		const key = await providerKeyOf(credentials, proxy, abortSignal)

		// Assert
		expect(key).toEqual({ status: 'missing' })
	})

	test("doesn't use the key of a provider without an origin, and says where it was set for", async () => {
		// Arrange
		const credentials = await credentialStore()
		await credentials.set(
			providerCredential('azure'),
			JSON.stringify({ key: 'sk-secret', origin: 'https://azure.example.com' }),
			abortSignal,
		)

		// Act
		const key = await providerKeyOf(credentials, { name: 'azure', kind: 'azure' }, abortSignal)

		// Assert
		expect(key).toEqual({ status: 'elsewhere', origin: 'https://azure.example.com' })
	})
})

describe('storeProviderKey', () => {
	test("refuses a provider of a kind the gateway doesn't know", async () => {
		// Arrange
		const credentials = await credentialStore()

		// Act
		const storing = storeProviderKey(credentials, { name: 'odd', kind: 'unknown-kind' }, 'sk-secret', abortSignal)

		// Assert
		await expect(storing).rejects.toThrow('unknown-kind')
		expect(await credentials.names(abortSignal)).toEqual([])
	})
})
