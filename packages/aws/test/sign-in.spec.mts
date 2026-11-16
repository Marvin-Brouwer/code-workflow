import { describe, expect, test, vi } from 'vitest'
import { awsCredentialNames } from '../src/host/aws-settings.mts'
import { slowDownStepMs } from '../src/host/device-authorization.mts'
import { signIn } from '../src/host/sign-in.mts'
import { msPerSecond } from '../src/host/time.mts'
import { abortSignal, promptlyMs, setUp, storedSession } from './support/aws-setup.mts'
import { lookIntervalSeconds } from './support/fake-aws.mts'

/** The fake's interval between looks for the approval. */
const lookIntervalMs = lookIntervalSeconds * msPerSecond

describe('signing in', () => {
	test('shows where to approve, waits for the approval, and keeps the session', async () => {
		// Arrange
		const { credentials, aws, shown, login } = await setUp({ fake: { pendingLooks: 2 } })

		// Act
		await login()

		// Assert
		expect(shown.map(({ url, code }) => ({ url, code }))).toEqual([
			{ url: `${aws.verificationUrl}?user_code=${aws.userCode}`, code: aws.userCode },
		])
		expect(aws.requests.filter((request) => request === 'POST /token')).toHaveLength(3)
		expect(await storedSession(credentials)).toMatchObject({ clientId: 'client-1', accessToken: 'access-1', refreshToken: 'refresh-2' })
	})

	test('registers the engine at each sign-in, so the session keeps the client it was signed in with', async () => {
		// Arrange
		const { aws, credentials, login } = await setUp()
		await login()

		// Act
		await login()

		// Assert
		expect(aws.requests.filter((request) => request === 'POST /client/register')).toHaveLength(2)
		expect(await storedSession(credentials)).toMatchObject({ clientId: 'client-2', clientSecret: 'client-secret-2' })
	})

	test('looks less often each time Identity Center says to slow down', async () => {
		// Arrange
		const { waited, login } = await setUp({ fake: { slowDowns: 2, pendingLooks: 1 } })

		// Act
		await login()

		// Assert
		expect(waited).toEqual([lookIntervalMs + slowDownStepMs, lookIntervalMs + 2 * slowDownStepMs, lookIntervalMs + 2 * slowDownStepMs])
	})

	test('says which settings are missing, with the commands that set them', async () => {
		// Arrange
		const { aws, login } = await setUp({ settings: false })

		// Act
		const signingIn = login()

		// Assert
		await expect(signingIn).rejects.toThrow('mesh-flow credential set aws/start-url')
		expect(aws.requests).toEqual([])
	})

	test('fails when the user denies the sign-in, and keeps no session', async () => {
		// Arrange
		const { credentials, login } = await setUp({ fake: { denied: true } })

		// Act
		const signingIn = login()

		// Assert
		await expect(signingIn).rejects.toThrow('The AWS sign-in was denied.')
		expect(await credentials.get(awsCredentialNames.session, abortSignal)).toBeUndefined()
	})

	test('says the sign-in ended when Identity Center ends the code before it was approved', async () => {
		// Arrange
		const { login } = await setUp({ fake: { deviceCodeExpired: true } })

		// Act
		const signingIn = login()

		// Assert
		await expect(signingIn).rejects.toThrow('The AWS sign-in ended before it was approved.')
	})

	test('settles when stopped while the user never approves', async () => {
		// Arrange
		const { credentials, aws, shown } = await setUp({ fake: { pendingLooks: Infinity } })
		const stop = new AbortController()
		const signingIn = signIn({ credentials, show: (prompt) => shown.push(prompt), abortSignal: stop.signal }, { endpoints: aws.endpoints })
		signingIn.catch(() => undefined)
		await vi.waitFor(() => {
			expect(aws.requests).toContain('POST /token')
		})

		// Act
		const started = Date.now()
		stop.abort(new Error('Ctrl+C'))

		// Assert
		await expect(signingIn).rejects.toThrow('Ctrl+C')
		expect(Date.now() - started).toBeLessThan(promptlyMs)
	})
})
