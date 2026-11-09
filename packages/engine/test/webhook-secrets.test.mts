import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { keyFile, openCredentialStore } from '@mesh-flow/gateway'
import { describe, expect, test } from 'vitest'
import { moveLegacyWebhookSecrets, openWebhookSecrets } from '../src/triggers/webhook-secrets.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

describe('moveLegacyWebhookSecrets', () => {
	test('moves the secrets an engine kept in its home into the credential store, and removes the file', async () => {
		// Arrange
		const home = await temporaryDirectory()
		const legacy = path.join(home, 'secrets', 'webhooks.json')
		await mkdir(path.dirname(legacy), { recursive: true })
		await writeFile(legacy, JSON.stringify({ 'team/fix-issue': 'old-secret', 'team/kept': 'old' }))
		const credentials = openCredentialStore(
			path.join(home, 'gateway', 'credentials.json'),
			keyFile(path.join(home, 'gateway', 'store.key')),
		)
		const secrets = openWebhookSecrets(credentials)
		await secrets.set('team', 'kept', 'newer', abortSignal)

		// Act
		const moved = await moveLegacyWebhookSecrets(home, credentials, abortSignal)

		// Assert
		expect(moved).toBe(1)
		expect(await secrets.get('team', 'fix-issue', abortSignal)).toBe('old-secret')
		expect(await secrets.get('team', 'kept', abortSignal)).toBe('newer')
		await expect(readFile(legacy, 'utf8')).rejects.toThrow('ENOENT')
	})
})
