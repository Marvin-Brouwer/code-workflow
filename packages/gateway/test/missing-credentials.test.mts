import { describe, expect, test } from 'vitest'
import type { CredentialReader } from '../src/credentials/credential-store.mts'
import { missingCredentials } from '../src/settings/missing-credentials.mts'

const abortSignal = AbortSignal.timeout(5_000)

/** A reader that holds only `values`. */
function readerWith(values: Readonly<Record<string, string>>): CredentialReader {
	return { get: async (name) => values[name] }
}

describe('missingCredentials', () => {
	test('names each credential that is not set, with its example', async () => {
		// Arrange
		const credentials = readerWith({ 'gitlab/url': 'https://gitlab.example.com' })

		// Act
		const missing = await missingCredentials(
			credentials,
			[
				{ name: 'gitlab/url', example: 'https://gitlab.example.com' },
				{ name: 'gitlab/token' },
				{ name: 'jira/url', example: 'https://example.atlassian.net' },
			],
			abortSignal,
		)

		// Assert
		expect(missing).toEqual([
			{
				message: "gitlab/token isn't set. Set it with `mesh-flow credential set gitlab/token`.",
				fix: { kind: 'credential', name: 'gitlab/token' },
			},
			{
				message: "jira/url isn't set. Set it with `echo 'https://example.atlassian.net' | mesh-flow credential set jira/url`.",
				fix: { kind: 'credential', name: 'jira/url', example: 'https://example.atlassian.net' },
			},
		])
	})
})
