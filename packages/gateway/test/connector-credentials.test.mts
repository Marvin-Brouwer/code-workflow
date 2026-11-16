import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { connectorCredentials } from '../src/credentials/connector-credentials.mts'
import { openCredentialStore } from '../src/credentials/credential-store.mts'
import { keyFile } from '../src/credentials/store-key.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

/** A credential store with a model provider's key and a credential of `aws` in it. */
async function store() {
	const home = await temporaryDirectory()
	const credentials = openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
	await credentials.set('provider/work', 'model key', abortSignal)
	await credentials.set('aws/role', 'Developer', abortSignal)
	return credentials
}

describe('connectorCredentials', () => {
	test("reads and writes the connector's own credentials, and lists only those", async () => {
		// Arrange
		const credentials = await store()
		const own = connectorCredentials(credentials, 'aws')

		// Act
		await own.set('aws/session', 'token', abortSignal)

		// Assert
		expect(await own.get('aws/role', abortSignal)).toBe('Developer')
		expect(await credentials.get('aws/session', abortSignal)).toBe('token')
		expect(await own.names(abortSignal)).toEqual(['aws/role', 'aws/session'])
	})

	test('refuses every other credential', async () => {
		// Arrange
		const own = connectorCredentials(await store(), 'aws')

		// Act
		const reading = own.get('provider/work', abortSignal)
		const writing = own.set('awsx/token', 'leak', abortSignal)

		// Assert
		await expect(reading).rejects.toThrow('only has the credentials named aws/')
		await expect(writing).rejects.toThrow('only has the credentials named aws/')
	})
})
