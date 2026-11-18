import { duration, sleep } from '@mesh-flow/duration'
import { describe, expect, test, vi } from 'vitest'
import { awsCredentialNames } from '../src/host/aws-settings.mts'
import { AwsSignInNeededError } from '../src/host/sign-in-needed.mts'
import { abortSignal, domain, holdRefreshes, promptly, setUp, storedSession } from './support/aws-setup.mts'

/** How long role credentials last in these tests. */
const roleCredentials = duration.of('1h')

/** When credentials of {@link roleCredentials} are three minutes into their renewal window (`renewAhead`), but not over. */
const nearTheirEnd = duration.of('58m')

/** How long after {@link nearTheirEnd} they are over. */
const pastTheirEnd = duration.of('3m')

/** An access token that is inside its renewal window after {@link accessTokenNearEnd}. */
const shortAccessToken = duration.of('10m')

/** How long after a sign-in an access token of {@link shortAccessToken} is renewed. */
const accessTokenNearEnd = duration.of('10m')

/** Role credentials that run out well before an access token of an hour needs renewing. */
const shortRoleCredentials = duration.of('10m')

/** How long after a sign-in an access token of an hour, the fake's default, is renewed. */
const accessTokenOver = duration.of('1h')

/** When credentials of {@link roleCredentials} hold for less than `useAhead` more: half of it. */
const almostOverAt = duration.of('59m45s')

/** Long enough for a call to reach what it waits on: a renewal under way, or a request of its own. */
const callReaches = duration.of('100ms')

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
		const { aws, clock, signInUser, session } = await setUp({ fake: { roleCredentials } })
		await signInUser()
		const opened = session()
		const first = await opened.roleCredentials(abortSignal)
		const again = await opened.roleCredentials(abortSignal)

		// Act
		clock.advance(nearTheirEnd)
		const renewed = await opened.roleCredentials(abortSignal)

		// Assert
		expect(again).toBe(first)
		expect(renewed.accessKeyId).not.toBe(first.accessKeyId)
		expect(aws.requests.filter((request) => request === 'GET /federation/credentials')).toHaveLength(2)
	})

	test('fetches new role credentials at once when the role in the settings changes', async () => {
		// Arrange
		const { credentials, signInUser, session } = await setUp()
		await signInUser()
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
		const { credentials, clock, signInUser, session } = await setUp({
			fake: { roleCredentials: shortRoleCredentials },
		})
		await signInUser()
		const opened = session()
		await opened.roleCredentials(abortSignal)

		// Act
		clock.advance(accessTokenOver)
		await opened.roleCredentials(abortSignal)

		// Assert
		expect(await storedSession(credentials)).toMatchObject({ accessToken: 'access-4', refreshToken: 'refresh-5' })
	})

	test('keeps the renewed session when the caller that started the renewal stops halfway', async () => {
		// Arrange
		const { aws, credentials, clock, signInUser, session } = await setUp({ fake: { accessToken: shortAccessToken } })
		await signInUser()
		clock.advance(accessTokenNearEnd)
		const refreshes = holdRefreshes(aws)
		const stop = new AbortController()
		const fetching = session().roleCredentials(stop.signal)
		await vi.waitFor(() => {
			expect(aws.requests.filter((request) => request === 'POST /token')).toHaveLength(2)
		})

		// Act
		stop.abort(new Error('stop'))
		await expect(fetching).rejects.toThrow('stop')
		refreshes.release()

		// Assert
		await vi.waitFor(async () => {
			expect(await storedSession(credentials)).toMatchObject({ accessToken: 'access-3', refreshToken: 'refresh-4' })
		})
		expect((await session().roleCredentials(abortSignal)).accessKeyId).toMatch(/^key-/)
	})

	test("lets a caller that comes during a stopped caller's renewal wait for it, rather than renew again", async () => {
		// Arrange
		const { aws, clock, signInUser, session } = await setUp({ fake: { accessToken: shortAccessToken } })
		await signInUser()
		clock.advance(accessTokenNearEnd)
		const refreshes = holdRefreshes(aws)
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
		await sleep(callReaches, abortSignal)
		const pending = aws.requests.filter((request) => request === 'POST /token').length
		refreshes.release()
		const fetched = await next

		// Assert
		expect(fetched.accessKeyId).toMatch(/^key-/)
		expect(pending).toBe(2)
		expect(aws.requests.filter((request) => request === 'POST /token')).toHaveLength(2)
	})

	test('keeps the session of a sign-in that came between a renewal and its write', async () => {
		// Arrange
		const { aws, credentials, clock, signInUser, session } = await setUp({ fake: { accessToken: shortAccessToken } })
		await signInUser()
		clock.advance(accessTokenNearEnd)
		const refreshes = holdRefreshes(aws)
		const fetching = session().roleCredentials(abortSignal)
		await vi.waitFor(() => {
			expect(aws.requests.filter((request) => request === 'POST /token')).toHaveLength(2)
		})

		// Act
		await signInUser()
		refreshes.release()
		await fetching

		// Assert
		expect(await storedSession(credentials)).toMatchObject({ clientId: 'client-2', accessToken: 'access-3', refreshToken: 'refresh-4' })
	})

	test('uses the session of a sign-in that came between, when Identity Center refuses the renewal it replaced', async () => {
		// Arrange
		const { aws, credentials, clock, signInUser, session } = await setUp({ fake: { accessToken: shortAccessToken } })
		await signInUser()
		clock.advance(accessTokenNearEnd)
		const refreshes = holdRefreshes(aws)
		const fetching = session().roleCredentials(abortSignal)
		await vi.waitFor(() => {
			expect(aws.requests.filter((request) => request === 'POST /token')).toHaveLength(2)
		})

		// Act
		await signInUser()
		aws.state.refreshWorks = false
		refreshes.release()
		const fetched = await fetching

		// Assert
		expect(fetched.accessKeyId).toMatch(/^key-/)
		expect(await storedSession(credentials)).toMatchObject({ clientId: 'client-2', accessToken: 'access-3' })
	})

	test('renews the access token once when the portal turns it down before its time', async () => {
		// Arrange
		const { aws, credentials, signInUser, session } = await setUp()
		await signInUser()
		aws.state.portalRejects = 1

		// Act
		const fetched = await session().roleCredentials(abortSignal)

		// Assert
		expect(fetched.accessKeyId).toMatch(/^key-/)
		expect(await storedSession(credentials)).toMatchObject({ accessToken: 'access-3', refreshToken: 'refresh-4' })
	})

	test('needs a sign-in when the access portal keeps turning the token down', async () => {
		// Arrange
		const { aws, signInUser, session } = await setUp()
		await signInUser()
		aws.state.portalRejects = Infinity

		// Act
		const fetching = session().roleCredentials(abortSignal)

		// Assert
		await expect(fetching).rejects.toThrow(AwsSignInNeededError)
	})

	test('keeps using the last credentials once the session ended, until they run out', async () => {
		// Arrange
		const { aws, clock, signInUser, session } = await setUp({
			fake: { accessToken: shortAccessToken, roleCredentials },
		})
		await signInUser()
		const opened = session()
		const last = await opened.roleCredentials(abortSignal)
		aws.state.refreshWorks = false

		// Act
		clock.advance(nearTheirEnd)
		const stillUsed = await opened.roleCredentials(abortSignal)
		clock.advance(pastTheirEnd)
		const afterwards = opened.roleCredentials(abortSignal)

		// Assert
		expect(stillUsed).toBe(last)
		await expect(afterwards).rejects.toThrow(AwsSignInNeededError)
		expect(await opened.status(abortSignal)).toBe('sign-in-needed')
	})

	test('needs a sign-in once the last credentials are too close to their end for a call', async () => {
		// Arrange
		const { aws, clock, signInUser, session } = await setUp({
			fake: { accessToken: shortAccessToken, roleCredentials },
		})
		await signInUser()
		const opened = session()
		await opened.roleCredentials(abortSignal)
		aws.state.refreshWorks = false

		// Act
		clock.advance(almostOverAt)
		const almostOver = opened.roleCredentials(abortSignal)

		// Assert
		await expect(almostOver).rejects.toThrow(AwsSignInNeededError)
	})

	test('hands out a CodeArtifact token per domain, renewed together with the role credentials', async () => {
		// Arrange
		const { aws, clock, signInUser, session } = await setUp({ fake: { roleCredentials } })
		await signInUser()
		const opened = session()
		const first = await opened.codeArtifactToken(domain, abortSignal)
		const again = await opened.codeArtifactToken(domain, abortSignal)
		const other = await opened.codeArtifactToken({ ...domain, domain: 'other' }, abortSignal)

		// Act
		clock.advance(nearTheirEnd)
		const renewed = await opened.codeArtifactToken(domain, abortSignal)

		// Assert
		expect(again).toBe(first)
		expect(other.token).toContain('codeartifact-other')
		expect(renewed.token).not.toBe(first.token)
		expect(aws.requests.filter((request) => request === 'GET /federation/credentials')).toHaveLength(2)
	})

	test('fetches new role credentials once when CodeArtifact turns the kept ones down', async () => {
		// Arrange
		const { aws, signInUser, session } = await setUp()
		await signInUser()
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
		const { aws, signInUser, session } = await setUp()
		await signInUser()
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
		expect(Date.now() - started).toBeLessThan(promptly.to('ms'))
	})

	test('settles a call waiting its turn behind one AWS never answers, when stopped', async () => {
		// Arrange
		const { aws, signInUser, session } = await setUp()
		await signInUser()
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
		expect(Date.now() - started).toBeLessThan(promptly.to('ms'))
	})
})
