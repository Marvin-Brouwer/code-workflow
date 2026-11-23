import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openCredentialStore } from '@mesh-flow/gateway'
import { describe, expect, onTestFinished, test } from 'vitest'
import { connector } from '../src/host/connector.mts'

const abortSignal = new AbortController().signal
/** The key the test's credential store is sealed with: any 32 bytes. */
const testKey = Buffer.alloc(32, 1)

describe('the connector', () => {
	test('says the token is missing until it is set', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'github-settings-'))
		onTestFinished(() => rm(directory, { recursive: true, force: true }))
		const credentials = openCredentialStore(path.join(directory, 'credentials.json'), {
			where: 'test',
			read: async () => testKey,
		})
		const options = { directory, credentials }

		// Act
		const before = await connector.missingSettings?.(options, abortSignal)
		await credentials.set('github/token', 'a-token', abortSignal)
		const after = await connector.missingSettings?.(options, abortSignal)

		// Assert
		expect(before?.map(({ fix }) => fix)).toEqual([{ kind: 'credential', name: 'github/token' }])
		expect(after).toEqual([])
	})
})
