import { openCredentialStore } from '@mesh-flow/gateway'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { connector } from '../src/host/connector.mts'

const abortSignal = AbortSignal.timeout(5_000)

describe('the connector', () => {
	test('says the token is missing until it is set', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'github-settings-'))
		const credentials = openCredentialStore(path.join(directory, 'credentials.json'), {
			where: 'test',
			read: async () => Buffer.alloc(32, 1),
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
