import type { CredentialReader } from '@mesh-flow/gateway'
import { describe, expect, test } from 'vitest'
import { missingSiteSettings } from '../src/host/site.mts'

const abortSignal = AbortSignal.timeout(5_000)

/** A reader that has only `set`. */
function readerWith(set: Readonly<Record<string, string>>): CredentialReader {
	return { get: async (name) => set[name] }
}

describe('missingSiteSettings', () => {
	test('asks for the Cloud settings when no product is on Data Center', async () => {
		// Act
		const missing = await missingSiteSettings(readerWith({ 'atlassian/url': 'https://example.atlassian.net' }), abortSignal)

		// Assert
		expect(missing.map(({ fix }) => fix)).toEqual([
			{ kind: 'credential', name: 'atlassian/email', example: 'bot@example.com' },
			{ kind: 'credential', name: 'atlassian/token' },
		])
	})

	test("asks for each Data Center product's token, and not for Cloud", async () => {
		// Act
		const missing = await missingSiteSettings(readerWith({ 'jira/url': 'https://jira.example.com' }), abortSignal)

		// Assert
		expect(missing.map(({ fix }) => fix)).toEqual([{ kind: 'credential', name: 'jira/token' }])
	})

	test('asks for nothing once Cloud is set', async () => {
		// Arrange
		const credentials = readerWith({
			'atlassian/url': 'https://example.atlassian.net',
			'atlassian/email': 'bot@example.com',
			'atlassian/token': 'token',
		})

		// Act
		const missing = await missingSiteSettings(credentials, abortSignal)

		// Assert
		expect(missing).toEqual([])
	})
})
