import { describe, expect, test, vi } from 'vitest'
import { awsCredentialNames } from '../src/host/aws-settings.mts'
import { renewAheadMs } from '../src/host/renewal.mts'
import { refreshTokenGrant } from '../src/host/oidc.mts'
import { AwsSignInNeededError } from '../src/host/sign-in-needed.mts'
import { msPerMinute } from '../src/host/time.mts'
import { abortSignal, domain, promptlyMs, setUp, storedSession } from './support/aws-setup.mts'

/** How long role credentials last in these tests. */
const roleCredentialsMinutes = 60

/** Minutes after which credentials of {@link roleCredentialsMinutes} are inside their renewal window, but not over. */
const nearTheirEndMinutes = roleCredentialsMinutes - renewAheadMs / msPerMinute + 3

/** Minutes after {@link nearTheirEndMinutes} at which they are over. */
const pastTheirEndMinutes = 3

/** An access token that is inside its renewal window after {@link accessTokenNearEndMinutes}. */
const shortAccessTokenSeconds = 600

/** Minutes after a sign-in at which an access token of {@link shortAccessTokenSeconds} is renewed. */
const accessTokenNearEndMinutes = 10

/** Role credentials that run out well before an access token of an hour needs renewing. */
const shortRoleCredentialsMinutes = 10

/** Minutes after which an access token of an hour, the fake's default, is renewed. */
const accessTokenOverMinutes = 60

/** Never settles: a request AWS never answers. */
const never = () => new Promise<void>(() => undefined)

describe('the AWS session', () => {
	test('needs a sign-in when there is no session', async () => {
		// Arrange
		const { session } = await setUp()

		// Act
		const fetching = session().roleCredentials(abortSignal)

		// Assert
		await expect(fetching).rejects.toThrow(AwsSignInNeededError)
		expect(await session().status(abortSignal)).toBe('sign-in-needed')
	})

	test('fetches role credentials once, and again when they near their end', async () => {
		// Arrange
		const { aws, clock, login, session } = await setUp({ fake: { roleCredentialsMs: roleCredentialsMinutes * msPerMinute } })
		await login()
		const opened = session()
		const first = await opened.roleCredentials(abortSignal)
		const again = await opened.roleCredentials(abortSignal)

		// Act
		clock.advance(nearTheirEndMinutes)
		const renewed = await opened.roleCredentials(abortSignal)

		// Assert
		expect(again).toBe(first)
		expect(renewed.accessKeyId).not.toBe(first.accessKeyId)
		expect(aws.requests.filter((request) => request === 'GET /federation/credentials')).toHaveLength(2)
	})

	test('fetches new role credentials at once when the role in the settings changes', async () => {
		// Arrange
		const { credentials, login, session } = await setUp()
		await login()
		const opened = session()
		const before = await opened.roleCredentials(abortSignal)

		// Act
		await credentials.set(awsCredentialNames.role, 'Admin', abortSignal)
		const after = await opened.roleCredentials(abortSignal)

		// Assert
		expect(after.accessKeyId).not.toBe(before.accessKeyId)
	})

	test('renews the access token with the refresh token, and keeps the new one', async () => {
		// Arrange
		const { credentials, clock, login, session } = await setUp({ fake: { roleCredentialsMs: shortRoleCredentialsMinutes * msPerMinute } })
		await login()
		const opened = session()
		await opened.roleCredentials(abortSignal)

		// Act
		clock.advance(accessTokenOverMinutes)
		await opened.roleCredentials(abortSignal)

		// Assert
		expect(await storedSession(credentials)).toMatchObject({ accessToken: 'access-4', refreshToken: 'refresh-5' })
	})

	test('keeps the renewed session when the caller that started the renewal stops halfway', async () => {
		// Arrange
		const { aws, credentials, clock, login, session } = await setUp({ fake: { accessTokenSeconds: shortAccessTokenSeconds } })
		await login()
		clock.advance(accessTokenNearEndMinutes)
		const answer = Promise.withResolvers<undefined>()
		aws.state.hold = (_requested, grantType) => (grantType === refreshTokenGrant ? answer.promise : Promise.resolve())
		const stop = new AbortController()
		const fetching = session().roleCredentials(stop.signal)
		await vi.waitFor(() => {
			expect(aws.requests.filter((request) => request === 'POST /token')).toHaveLength(2)
		})

		// Act
		stop.abort(new Error('stop'))
		await expect(fetching).rejects.toThrow('stop')
		answer.resolve(undefined)

		// Assert
		await vi.waitFor(async () => {
			expect(await storedSession(credentials)).toMatchObject({ accessToken: 'access-3', refreshToken: 'refresh-4' })
		})
		expect((await session().roleCredentials(abortSignal)).accessKeyId).toMatch(/^key-/)
	})

	test("lets a caller that comes during a stopped caller's renewal wait for it, rather than renew again", async () => {
		// Arrange
		const { aws, clock, login, session } = await setUp({ fake: { accessTokenSeconds: shortAccessTokenSeconds } })
		await login()
		clock.advance(accessTokenNearEndMinutes)
		const answer = Promise.withResolvers<undefined>()
		aws.state.hold = (_requested, grantType) => (grantType === refreshTokenGrant ? answer.promise : Promise.resolve())
		const opened = session()
		const stop = new AbortController()
		const stopped = opened.roleCredentials(stop.signal)
		stopped.catch(() => undefined)
		await vi.waitFor(() => {
			expect(aws.requests.filter((request) => request === 'POST /token')).toHaveLength(2)
		})
		stop.abort(new Error('stop'))
		await expect(stopped).rejects.toThrow('stop')

		// Act
		const next = opened.roleCredentials(abortSignal)
		answer.resolve(undefined)
		const fetched = await next

		// Assert
		expect(fetched.accessKeyId).toMatch(/^key-/)
		expect(aws.requests.filter((request) => request === 'POST /token')).toHaveLength(2)
	})

	test('keeps the session of a sign-in that came between a renewal and its write', async () => {
		// Arrange
		const { aws, credentials, clock, login, session } = await setUp({ fake: { accessTokenSeconds: shortAccessTokenSeconds } })
		await login()
		clock.advance(accessTokenNearEndMinutes)
		const answer = Promise.withResolvers<undefined>()
		aws.state.hold = (_requested, grantType) => (grantType === refreshTokenGrant ? answer.promise : Promise.resolve())
		const fetching = session().roleCredentials(abortSignal)
		await vi.waitFor(() => {
			expect(aws.requests.filter((request) => request === 'POST /token')).toHaveLength(2)
		})

		// Act
		await login()
		answer.resolve(undefined)
		await fetching

		// Assert
		expect(await storedSession(credentials)).toMatchObject({ clientId: 'client-2', accessToken: 'access-3', refreshToken: 'refresh-4' })
	})

	test('renews the access token once when the portal turns it down before its time', async () => {
		// Arrange
		const { aws, credentials, login, session } = await setUp()
		await login()
		aws.state.portalRejects = 1

		// Act
		const fetched = await session().roleCredentials(abortSignal)

		// Assert
		expect(fetched.accessKeyId).toMatch(/^key-/)
		expect(await storedSession(credentials)).toMatchObject({ accessToken: 'access-3', refreshToken: 'refresh-4' })
	})

	test('needs a sign-in when the access portal keeps turning the token down', async () => {
		// Arrange
		const { aws, login, session } = await setUp()
		await login()
		aws.state.portalRejects = Infinity

		// Act
		const fetching = session().roleCredentials(abortSignal)

		// Assert
		await expect(fetching).rejects.toThrow(AwsSignInNeededError)
	})

	test('keeps using the last credentials once the session ended, until they run out', async () => {
		// Arrange
		const { aws, clock, login, session } = await setUp({
			fake: { accessTokenSeconds: shortAccessTokenSeconds, roleCredentialsMs: roleCredentialsMinutes * msPerMinute },
		})
		await login()
		const opened = session()
		const last = await opened.roleCredentials(abortSignal)
		aws.state.refreshWorks = false

		// Act
		clock.advance(nearTheirEndMinutes)
		const stillUsed = await opened.roleCredentials(abortSignal)
		clock.advance(pastTheirEndMinutes)
		const afterwards = opened.roleCredentials(abortSignal)

		// Assert
		expect(stillUsed).toBe(last)
		await expect(afterwards).rejects.toThrow(AwsSignInNeededError)
		expect(await opened.status(abortSignal)).toBe('sign-in-needed')
	})

	test('hands out a CodeArtifact token per domain, renewed together with the role credentials', async () => {
		// Arrange
		const { aws, clock, login, session } = await setUp({ fake: { roleCredentialsMs: roleCredentialsMinutes * msPerMinute } })
		await login()
		const opened = session()
		const first = await opened.codeArtifactToken(domain, abortSignal)
		const again = await opened.codeArtifactToken(domain, abortSignal)
		const other = await opened.codeArtifactToken({ ...domain, domain: 'other' }, abortSignal)

		// Act
		clock.advance(nearTheirEndMinutes)
		const renewed = await opened.codeArtifactToken(domain, abortSignal)

		// Assert
		expect(again).toBe(first)
		expect(other.token).toContain('codeartifact-other')
		expect(renewed.token).not.toBe(first.token)
		expect(aws.requests.filter((request) => request === 'GET /federation/credentials')).toHaveLength(2)
	})

	test('fetches new role credentials once when CodeArtifact turns the kept ones down', async () => {
		// Arrange
		const { aws, login, session } = await setUp()
		await login()
		const opened = session()
		await opened.roleCredentials(abortSignal)
		aws.state.codeArtifactRejects = 1

		// Act
		const token = await opened.codeArtifactToken(domain, abortSignal)

		// Assert
		expect(token.token).toContain('codeartifact-example')
		expect(aws.requests.filter((request) => request === 'GET /federation/credentials')).toHaveLength(2)
	})

	test.each([
		['role credentials', '/federation/credentials', 'roleCredentials'],
		['a CodeArtifact token', '/v1/authorization-token', 'codeArtifactToken'],
		['a status', '/federation/credentials', 'status'],
	] as const)('settles %s when stopped while AWS never answers', async (_what, path, call) => {
		// Arrange
		const { aws, login, session } = await setUp()
		await login()
		aws.state.hold = (requested) => (requested === path ? never() : Promise.resolve())
		const opened = session()
		const stop = new AbortController()
		const calls = {
			roleCredentials: () => opened.roleCredentials(stop.signal),
			codeArtifactToken: () => opened.codeArtifactToken(domain, stop.signal),
			status: () => opened.status(stop.signal),
		}
		const calling = calls[call]()
		calling.catch(() => undefined)
		await vi.waitFor(() => {
			expect(aws.requests.at(-1)).toContain(path)
		})

		// Act
		const started = Date.now()
		stop.abort(new Error('stop'))

		// Assert
		await expect(calling).rejects.toThrow('stop')
		expect(Date.now() - started).toBeLessThan(promptlyMs)
	})

	test('settles a call waiting its turn behind one AWS never answers, when stopped', async () => {
		// Arrange
		const { aws, login, session } = await setUp()
		await login()
		aws.state.hold = (requested) => (requested === '/federation/credentials' ? never() : Promise.resolve())
		const opened = session()
		const first = opened.roleCredentials(abortSignal)
		first.catch(() => undefined)
		await vi.waitFor(() => {
			expect(aws.requests).toContain('GET /federation/credentials')
		})
		const stop = new AbortController()
		const waiting = opened.roleCredentials(stop.signal)
		waiting.catch(() => undefined)

		// Act
		const started = Date.now()
		stop.abort(new Error('stop'))

		// Assert
		await expect(waiting).rejects.toThrow('stop')
		expect(Date.now() - started).toBeLessThan(promptlyMs)
	})
})
