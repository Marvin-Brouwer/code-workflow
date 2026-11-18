import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { text } from 'node:stream/consumers'
import { onTestFinished } from 'vitest'
import type { AwsEndpoints } from '../../src/host/aws-endpoints.mts'
import { refreshTokenGrant } from '../../src/host/oidc.mts'
import { msPerSecond } from '../../src/host/time.mts'

/** How long a client registration lasts: Identity Center's 90 days. */
const registrationSeconds = 90 * 24 * 3600

/** How long a device code lasts. */
const deviceCodeSeconds = 600

/** How often the device flow may look for the approval. */
export const lookIntervalSeconds = 1

/** How long an access token lasts unless a test says otherwise. */
const defaultAccessTokenSeconds = 3600

/** How long role credentials last unless a test says otherwise. */
const defaultRoleCredentialsMs = 3600 * msPerSecond

/** How the fake Identity Center, access portal and CodeArtifact behave, changed as a test goes. */
export interface FakeAwsState {
	/** How many looks for the approval answer `authorization_pending` before it's approved. `Infinity`: never. */
	pendingLooks: number
	/** How many looks for the approval answer `slow_down` first. */
	slowDowns: number
	/** The user denied the sign-in. */
	denied: boolean
	/** Identity Center ended the device code before the user approved it. */
	deviceCodeExpired: boolean
	/** Seconds an access token lasts. */
	accessTokenSeconds: number
	/** Whether a refresh token is handed out, and whether it still works: `false` once the session ended. */
	refreshWorks: boolean
	/** Milliseconds role credentials last, from when they are fetched. */
	roleCredentialsMs: number
	/** How many fetches of role credentials the portal turns down next. `Infinity`: every one. */
	portalRejects: number
	/** How many token fetches CodeArtifact turns down next, as if the role credentials ended. */
	codeArtifactRejects: number
	/** Awaited before a request is answered, with its path and, for `/token`, its grant type, such as to hold it, or never answer. */
	hold: ((path: string, grantType: unknown) => Promise<void>) | undefined
}

/** What the fake was asked, as `METHOD /path`, in order. */
export type FakeAwsRequests = string[]

/** The fake, where to reach it, and what it was asked. */
export interface FakeAws {
	readonly endpoints: Required<AwsEndpoints>
	readonly state: FakeAwsState
	readonly requests: FakeAwsRequests
	/** The device authorization's user code and its page. */
	readonly userCode: string
	readonly verificationUrl: string
}

const userCode = 'ABCD-EFGH'
const verificationUrl = 'https://device.sso.eu-west-1.amazonaws.com/'

/** Answers as AWS's JSON protocols do, an error with its type in `x-amzn-errortype`. */
function json(response: ServerResponse, status: number, body: unknown, errorType?: string): void {
	response.writeHead(status, {
		'content-type': 'application/json',
		...(errorType === undefined ? {} : { 'x-amzn-errortype': errorType }),
	})
	response.end(JSON.stringify(body))
}

/**
 * One fake for the three AWS services the connector talks to, on loopback, closed when the test
 * ends. Like Identity Center, it hands out a new refresh token on each renewal, and takes each
 * one only once, and only from the client it was handed to.
 */
export async function fakeAws(now: () => Date, overrides: Partial<FakeAwsState> = {}): Promise<FakeAws> {
	const state: FakeAwsState = {
		pendingLooks: 0,
		slowDowns: 0,
		denied: false,
		deviceCodeExpired: false,
		accessTokenSeconds: defaultAccessTokenSeconds,
		refreshWorks: true,
		roleCredentialsMs: defaultRoleCredentialsMs,
		portalRejects: 0,
		codeArtifactRejects: 0,
		hold: undefined,
		...overrides,
	}
	const requests: FakeAwsRequests = []
	let looks = 0
	let issued = 0
	let registered = 0
	const nextToken = (kind: string) => `${kind}-${String(++issued)}`
	/** The refresh tokens that still work, and the client each was handed to. */
	const liveRefreshTokens = new Map<string, unknown>()

	const tokens = (response: ServerResponse, clientId: unknown) => {
		const accessToken = nextToken('access')
		const refreshToken = state.refreshWorks ? nextToken('refresh') : undefined
		if (refreshToken !== undefined) liveRefreshTokens.set(refreshToken, clientId)
		json(response, 200, {
			accessToken,
			tokenType: 'Bearer',
			expiresIn: state.accessTokenSeconds,
			...(refreshToken === undefined ? {} : { refreshToken }),
		})
	}

	const deviceToken = (response: ServerResponse, clientId: unknown) => {
		if (state.denied) json(response, 400, { error: 'access_denied' }, 'AccessDeniedException')
		else if (state.deviceCodeExpired) json(response, 400, { error: 'expired_token' }, 'ExpiredTokenException')
		else if (looks++ < state.slowDowns) json(response, 400, { error: 'slow_down' }, 'SlowDownException')
		else if (looks <= state.slowDowns + state.pendingLooks)
			json(response, 400, { error: 'authorization_pending' }, 'AuthorizationPendingException')
		else tokens(response, clientId)
	}

	const serve = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? '/', 'http://fake')
		requests.push(`${request.method ?? ''} ${url.pathname}`)
		const body: unknown = request.method === 'POST' ? JSON.parse((await text(request)) || '{}') : {}
		const field = (name: string): unknown =>
			typeof body === 'object' && body !== null ? Object.entries(body).find(([key]) => key === name)?.[1] : undefined
		await state.hold?.(url.pathname, field('grantType'))
		if (url.pathname === '/client/register') {
			registered++
			json(response, 200, {
				clientId: `client-${String(registered)}`,
				clientSecret: `client-secret-${String(registered)}`,
				clientIdIssuedAt: Math.floor(now().getTime() / msPerSecond),
				clientSecretExpiresAt: Math.floor(now().getTime() / msPerSecond) + registrationSeconds,
			})
			return
		}
		if (url.pathname === '/device_authorization') {
			looks = 0
			json(response, 200, {
				deviceCode: 'device-1',
				userCode,
				verificationUri: verificationUrl,
				verificationUriComplete: `${verificationUrl}?user_code=${userCode}`,
				expiresIn: deviceCodeSeconds,
				interval: lookIntervalSeconds,
			})
			return
		}
		if (url.pathname === '/token') {
			if (field('grantType') !== refreshTokenGrant) {
				deviceToken(response, field('clientId'))
				return
			}
			const refreshToken = field('refreshToken')
			const live = typeof refreshToken === 'string' && liveRefreshTokens.get(refreshToken) === field('clientId')
			if (!state.refreshWorks || !live) {
				json(response, 400, { error: 'invalid_grant' }, 'InvalidGrantException')
				return
			}
			liveRefreshTokens.delete(refreshToken)
			tokens(response, field('clientId'))
			return
		}
		if (url.pathname === '/federation/credentials') {
			const rejected = state.portalRejects > 0 || request.headers['x-amz-sso_bearer_token'] === undefined
			if (rejected) {
				state.portalRejects = Math.max(0, state.portalRejects - 1)
				json(response, 401, { message: 'Session token not found or invalid' }, 'UnauthorizedException')
				return
			}
			json(response, 200, {
				roleCredentials: {
					accessKeyId: nextToken('key'),
					secretAccessKey: 'secret',
					sessionToken: 'session',
					expiration: now().getTime() + state.roleCredentialsMs,
				},
			})
			return
		}
		if (url.pathname === '/v1/authorization-token') {
			if (state.codeArtifactRejects > 0) {
				state.codeArtifactRejects--
				json(response, 403, { message: 'The security token included in the request is expired' }, 'ExpiredTokenException')
				return
			}
			json(response, 200, {
				authorizationToken: nextToken(`codeartifact-${url.searchParams.get('domain') ?? ''}`),
				expiration: Math.floor((now().getTime() + state.roleCredentialsMs) / msPerSecond),
			})
			return
		}
		json(response, 404, { message: `No fake for ${url.pathname}` })
	}

	const server = createServer((request, response) => {
		serve(request, response).catch((error: unknown) => {
			json(response, 500, { message: String(error) })
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	onTestFinished(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections()
				server.close(() => {
					resolve()
				})
			}),
	)
	const address = server.address()
	const port = typeof address === 'object' && address !== null ? address.port : 0
	const origin = `http://127.0.0.1:${String(port)}`
	return { endpoints: { oidc: origin, sso: origin, codeArtifact: origin }, state, requests, userCode, verificationUrl }
}
