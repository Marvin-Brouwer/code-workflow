import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { openCredentialStore } from '../src/credentials/credential-store.mts'
import { keyFile } from '../src/credentials/store-key.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

async function store(home?: string) {
	const directory = home ?? (await temporaryDirectory())
	const file = path.join(directory, 'credentials.json')
	return { file, directory, store: openCredentialStore(file, keyFile(path.join(directory, 'store.key'))) }
}

describe('openCredentialStore', () => {
	test('keeps a secret and gives it back, sealed on disk', async () => {
		// Arrange
		const { store: credentials, file } = await store()

		// Act
		await credentials.set('provider/anthropic', 'sk-secret-value', abortSignal)

		// Assert
		expect(await credentials.get('provider/anthropic', abortSignal)).toBe('sk-secret-value')
		expect(await readFile(file, 'utf8')).not.toContain('sk-secret-value')
	})

	test('lists names, never secrets, and removes one', async () => {
		// Arrange
		const { store: credentials } = await store()
		await credentials.set('webhook/team/b', 'one', abortSignal)
		await credentials.set('provider/a', 'two', abortSignal)

		// Act
		const removed = await credentials.remove('webhook/team/b', abortSignal)

		// Assert
		expect(removed).toBe(true)
		expect(await credentials.names(abortSignal)).toEqual(['provider/a'])
		expect(await credentials.remove('webhook/team/b', abortSignal)).toBe(false)
	})

	test('sees what another opening of the store wrote, as the CLI and the engine do', async () => {
		// Arrange
		const { store: engine, directory } = await store()
		const { store: cli } = await store(directory)

		// Act
		await cli.set('provider/openai', 'sk-from-cli', abortSignal)

		// Assert
		expect(await engine.get('provider/openai', abortSignal)).toBe('sk-from-cli')
	})

	test("doesn't open with another key", async () => {
		// Arrange
		const { store: credentials, file } = await store()
		await credentials.set('provider/a', 'secret', abortSignal)
		const other = openCredentialStore(file, keyFile(path.join(await temporaryDirectory(), 'other.key')))

		// Act
		const reading = other.get('provider/a', abortSignal)

		// Assert
		await expect(reading).rejects.toThrow("doesn't open with this key")
	})

	test('refuses a name that could be a path', async () => {
		// Arrange
		const { store: credentials } = await store()

		// Act
		const setting = credentials.set('provider a', 'secret', abortSignal)

		// Assert
		await expect(setting).rejects.toThrow()
	})
})
