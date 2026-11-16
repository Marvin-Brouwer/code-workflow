import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { text } from 'node:stream/consumers'
import { onTestFinished } from 'vitest'
import type { AwsEndpoints } from '../../src/host/aws-endpoints.mts'

const msPerSecond = 1000

/** How the fake Identity Center, access portal and CodeArtifact behave, changed as a test goes. */
export interface FakeAwsState {
	/** How many looks for the approval answer `authorization_pending` before it's approved. `Infinity`: never. */
	pendingLooks: number
	/** The user denied the sign-in. */
	denied: boolean
	/** Seconds an access token lasts. */
	accessTokenSeconds: number
	/** Whether a refresh token is handed out, and whether it still works: `false` once the session ended. */
	refreshWorks: boolean
	/** Milliseconds role credentials last, from when they are fetched. */
	roleCredentialsMs: number
	/** Whether the access portal takes the access token. */
	portalWorks: boolean
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

/** One fake for the three AWS services the connector talks to, on loopback, closed when the test ends. */
export async function fakeAws(now: () => Date, overrides: Partial<FakeAwsState> = {}): Promise<FakeAws> {
	const state: FakeAwsState = {
		pendingLooks: 0,
		denied: false,
		accessTokenSeconds: 3600,
		refreshWorks: true,
		roleCredentialsMs: 3_600_000,
		portalWorks: true,
		...overrides,
	}
	const requests: FakeAwsRequests = []
	let looks = 0
	let issued = 0
	const nextToken = (kind: string) => `${kind}-${String(++issued)}`

	const tokens = (response: ServerResponse) => {
		json(response, 200, {
			accessToken: nextToken('access'),
			tokenType: 'Bearer',
			expiresIn: state.accessTokenSeconds,
			...(state.refreshWorks ? { refreshToken: nextToken('refresh') } : {}),
		})
	}

	const serve = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? '/', 'http://fake')
		requests.push(`${request.method ?? ''} ${url.pathname}`)
		const body: unknown = request.method === 'POST' ? JSON.parse((await text(request)) || '{}') : {}
		const field = (name: string): unknown =>
			typeof body === 'object' && body !== null ? Object.entries(body).find(([key]) => key === name)?.[1] : undefined
		if (url.pathname === '/client/register') {
			json(response, 200, {
				clientId: 'client-1',
				clientSecret: 'client-secret-1',
				clientIdIssuedAt: Math.floor(now().getTime() / msPerSecond),
				clientSecretExpiresAt: Math.floor(now().getTime() / msPerSecond) + 90 * 24 * 3600,
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
				expiresIn: 600,
				interval: 1,
			})
			return
		}
		if (url.pathname === '/token') {
			if (field('grantType') === 'refresh_token') {
				if (!state.refreshWorks) json(response, 400, { error: 'invalid_grant' }, 'InvalidGrantException')
				else tokens(response)
				return
			}
			if (state.denied) json(response, 400, { error: 'access_denied' }, 'AccessDeniedException')
			else if (looks++ < state.pendingLooks) json(response, 400, { error: 'authorization_pending' }, 'AuthorizationPendingException')
			else tokens(response)
			return
		}
		if (url.pathname === '/federation/credentials') {
			if (!state.portalWorks || request.headers['x-amz-sso_bearer_token'] === undefined) {
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
