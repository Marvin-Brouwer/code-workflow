import path from 'node:path'
import { keyFile, openCredentialStore, type CredentialStore, type LoginPrompt } from '@mesh-flow/gateway'
import { describe, expect, test, vi } from 'vitest'
import { openAwsSession } from '../src/host/aws-session.mts'
import { awsCredentialNames } from '../src/host/aws-settings.mts'
import { signIn } from '../src/host/sign-in.mts'
import { AwsSignInNeeded } from '../src/host/sign-in-needed.mts'
import { fakeAws, type FakeAwsState } from './support/fake-aws.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

/** How long a sign-in may take to settle once stopped, while the user never approves. */
const promptlyMs = 3_000

const msPerMinute = 60_000

const settings = {
	[awsCredentialNames.startUrl]: 'https://example.awsapps.com/start',
	[awsCredentialNames.ssoRegion]: 'eu-west-1',
	[awsCredentialNames.account]: '123456789012',
	[awsCredentialNames.role]: 'Developer',
}

const domain = { domain: 'example', owner: '123456789012', region: 'eu-west-1' }

/** A clock a test moves on by hand. */
function testClock() {
	let current = new Date('2026-11-16T09:00:00.000Z')
	return {
		now: () => current,
		advance: (minutes: number) => {
			current = new Date(current.getTime() + minutes * msPerMinute)
		},
	}
}

/** A credential store with the AWS settings in, a fake AWS, and a clock. */
async function setUp(fake: Partial<FakeAwsState> = {}, withSettings = true) {
	const home = await temporaryDirectory()
	const credentials = openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
	if (withSettings) for (const [name, value] of Object.entries(settings)) await credentials.set(name, value, abortSignal)
	const clock = testClock()
	const aws = await fakeAws(clock.now, fake)
	const shown: LoginPrompt[] = []
	const login = (signal = abortSignal) =>
		signIn(
			{ credentials, show: (prompt) => shown.push(prompt), abortSignal: signal },
			{ endpoints: aws.endpoints, now: clock.now, wait: () => Promise.resolve() },
		)
	const session = () => openAwsSession({ credentials, endpoints: aws.endpoints, now: clock.now })
	return { credentials, clock, aws, shown, login, session }
}

async function storedSession(credentials: CredentialStore): Promise<unknown> {
	return JSON.parse((await credentials.get(awsCredentialNames.session, abortSignal)) ?? 'null')
}

describe('signing in', () => {
	test('shows where to approve, waits for the approval, and keeps the session', async () => {
		// Arrange
		const { credentials, aws, shown, login } = await setUp({ pendingLooks: 2 })

		// Act
		await login()

		// Assert
		expect(shown.map(({ url, code }) => ({ url, code }))).toEqual([
			{ url: `${aws.verificationUrl}?user_code=${aws.userCode}`, code: aws.userCode },
		])
		expect(aws.requests.filter((request) => request === 'POST /token')).toHaveLength(3)
		expect(await storedSession(credentials)).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-2' })
	})

	test('registers the engine once, and keeps the registration for the next sign-in', async () => {
		// Arrange
		const { aws, login } = await setUp()
		await login()

		// Act
		await login()

		// Assert
		expect(aws.requests.filter((request) => request === 'POST /client/register')).toHaveLength(1)
	})

	test('says which settings are missing, with the commands that set them', async () => {
		// Arrange
		const { aws, login } = await setUp({}, false)

		// Act
		const signingIn = login()

		// Assert
		await expect(signingIn).rejects.toThrow('mesh-flow credential set aws/start-url')
		expect(aws.requests).toEqual([])
	})

	test('fails when the user denies the sign-in, and keeps no session', async () => {
		// Arrange
		const { credentials, login } = await setUp({ denied: true })

		// Act
		const signingIn = login()

		// Assert
		await expect(signingIn).rejects.toThrow()
		expect(await credentials.get(awsCredentialNames.session, abortSignal)).toBeUndefined()
	})

	test('stops promptly while the user never approves', async () => {
		// Arrange
		const { credentials, aws, shown } = await setUp({ pendingLooks: Infinity })
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

describe('the AWS session', () => {
	test('needs a sign-in when there is no session', async () => {
		// Arrange
		const { session } = await setUp()

		// Act
		const fetching = session().roleCredentials(abortSignal)

		// Assert
		await expect(fetching).rejects.toThrow(AwsSignInNeeded)
		expect(await session().status(abortSignal)).toBe('sign-in-needed')
	})

	test('fetches role credentials once, and again when they near their end', async () => {
		// Arrange
		const { aws, clock, login, session } = await setUp({ roleCredentialsMs: 60 * msPerMinute })
		await login()
		const opened = session()
		const first = await opened.roleCredentials(abortSignal)
		const again = await opened.roleCredentials(abortSignal)

		// Act
		clock.advance(58)
		const renewed = await opened.roleCredentials(abortSignal)

		// Assert
		expect(again).toBe(first)
		expect(renewed.accessKeyId).not.toBe(first.accessKeyId)
		expect(aws.requests.filter((request) => request === 'GET /federation/credentials')).toHaveLength(2)
	})

	test('renews the access token with the refresh token, and keeps the new one', async () => {
		// Arrange
		const { credentials, clock, login, session } = await setUp({ accessTokenSeconds: 3600, roleCredentialsMs: 10 * msPerMinute })
		await login()
		const opened = session()
		await opened.roleCredentials(abortSignal)

		// Act
		clock.advance(60)
		await opened.roleCredentials(abortSignal)

		// Assert
		expect(await storedSession(credentials)).toMatchObject({ accessToken: 'access-4', refreshToken: 'refresh-5' })
	})

	test('keeps using the last credentials once the session ended, until they run out', async () => {
		// Arrange
		const { aws, clock, login, session } = await setUp({ accessTokenSeconds: 600, roleCredentialsMs: 60 * msPerMinute })
		await login()
		const opened = session()
		const last = await opened.roleCredentials(abortSignal)
		aws.state.refreshWorks = false

		// Act
		clock.advance(58)
		const stillUsed = await opened.roleCredentials(abortSignal)
		clock.advance(3)
		const afterwards = opened.roleCredentials(abortSignal)

		// Assert
		expect(stillUsed).toBe(last)
		await expect(afterwards).rejects.toThrow(AwsSignInNeeded)
		expect(await opened.status(abortSignal)).toBe('sign-in-needed')
	})

	test('needs a sign-in when the access portal turns the token down', async () => {
		// Arrange
		const { aws, login, session } = await setUp()
		await login()
		aws.state.portalWorks = false

		// Act
		const fetching = session().roleCredentials(abortSignal)

		// Assert
		await expect(fetching).rejects.toThrow(AwsSignInNeeded)
	})

	test('hands out a CodeArtifact token per domain, renewed together with the role credentials', async () => {
		// Arrange
		const { aws, clock, login, session } = await setUp({ roleCredentialsMs: 60 * msPerMinute })
		await login()
		const opened = session()
		const first = await opened.codeArtifactToken(domain, abortSignal)
		const again = await opened.codeArtifactToken(domain, abortSignal)
		const other = await opened.codeArtifactToken({ ...domain, domain: 'other' }, abortSignal)

		// Act
		clock.advance(58)
		const renewed = await opened.codeArtifactToken(domain, abortSignal)

		// Assert
		expect(again).toBe(first)
		expect(other.token).toContain('codeartifact-other')
		expect(renewed.token).not.toBe(first.token)
		expect(aws.requests.filter((request) => request === 'GET /federation/credentials')).toHaveLength(2)
	})
})
