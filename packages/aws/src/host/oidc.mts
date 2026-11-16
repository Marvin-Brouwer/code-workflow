import {
	AuthorizationPendingException,
	CreateTokenCommand,
	RegisterClientCommand,
	SlowDownException,
	SSOOIDCClient,
	StartDeviceAuthorizationCommand,
} from '@aws-sdk/client-sso-oidc'
import type { CredentialStore } from '@mesh-flow/gateway'
import type { AwsEndpoints } from './aws-endpoints.mts'
import { awsCredentialNames, type AwsSettings } from './aws-settings.mts'
import { readStored, RegisteredClient, type StoredSession, writeStored } from './stored-session.mts'

/** The OAuth grant a device authorization ends in. */
export const deviceCodeGrant = 'urn:ietf:params:oauth:grant-type:device_code'

/** The OAuth grant that renews an access token. */
export const refreshTokenGrant = 'refresh_token'

/** The scope that lets a token fetch role credentials from the access portal. */
const accountAccessScope = 'sso:account:access'

/** How the engine names itself to Identity Center. */
const clientName = 'mesh-flow'

/** How long before its end a registration or token is renewed, so it doesn't end mid-call. */
export const renewAheadMs = 5 * 60 * 1000

const msPerSecond = 1000

/** Identity Center's OIDC service in the settings' region. */
export function oidcClient(settings: AwsSettings, endpoints: AwsEndpoints): SSOOIDCClient {
	return new SSOOIDCClient({ region: settings.ssoRegion, ...(endpoints.oidc === undefined ? {} : { endpoint: endpoints.oidc }) })
}

/** When something that lasts `seconds` from `now` ends. */
export function expiresIn(now: Date, seconds: number | undefined): Date {
	return new Date(now.getTime() + (seconds ?? 0) * msPerSecond)
}

/**
 * This engine's client registration for the settings: the kept one while it lasts, else a new one,
 * which is kept. A public client, allowed the device flow and refresh tokens.
 */
export async function registeredClient(
	credentials: CredentialStore,
	settings: AwsSettings,
	oidc: SSOOIDCClient,
	now: () => Date,
	abortSignal: AbortSignal,
): Promise<RegisteredClient> {
	const kept = await readStored(credentials, awsCredentialNames.client, RegisteredClient, abortSignal)
	if (
		kept !== undefined &&
		kept.ssoRegion === settings.ssoRegion &&
		kept.startUrl === settings.startUrl &&
		Date.parse(kept.expiresAt) - renewAheadMs > now().getTime()
	)
		return kept
	const registered = await oidc.send(
		new RegisterClientCommand({
			clientName,
			clientType: 'public',
			scopes: [accountAccessScope],
			grantTypes: [deviceCodeGrant, refreshTokenGrant],
		}),
		{ abortSignal },
	)
	if (registered.clientId === undefined || registered.clientSecret === undefined)
		throw new Error('Identity Center registered no client: it sent no client id or secret.')
	const client: RegisteredClient = {
		ssoRegion: settings.ssoRegion,
		startUrl: settings.startUrl,
		clientId: registered.clientId,
		clientSecret: registered.clientSecret,
		expiresAt: new Date((registered.clientSecretExpiresAt ?? 0) * msPerSecond).toISOString(),
	}
	await writeStored(credentials, awsCredentialNames.client, client, abortSignal)
	return client
}

/** A device authorization the user has yet to approve. */
export interface DeviceAuthorization {
	readonly deviceCode: string
	readonly url: string
	readonly code: string
	readonly expiresAt: Date
	/** How long to wait between looks, as Identity Center asks. */
	readonly intervalMs: number
}

/** When Identity Center doesn't say how often to look: RFC 8628's default. */
const defaultIntervalSeconds = 5

/** How much longer to wait between looks after Identity Center says to slow down: RFC 8628's step. */
const slowDownStepMs = 5 * msPerSecond

/** Starts a device authorization for the access portal in the settings. */
export async function startDeviceAuthorization(
	client: RegisteredClient,
	settings: AwsSettings,
	oidc: SSOOIDCClient,
	now: () => Date,
	abortSignal: AbortSignal,
): Promise<DeviceAuthorization> {
	const started = await oidc.send(
		new StartDeviceAuthorizationCommand({ clientId: client.clientId, clientSecret: client.clientSecret, startUrl: settings.startUrl }),
		{ abortSignal },
	)
	const url = started.verificationUriComplete ?? started.verificationUri
	if (started.deviceCode === undefined || started.userCode === undefined || url === undefined)
		throw new Error('Identity Center started no device authorization: it sent no device code, user code or URL.')
	return {
		deviceCode: started.deviceCode,
		url,
		code: started.userCode,
		expiresAt: expiresIn(now(), started.expiresIn),
		intervalMs: (started.interval ?? defaultIntervalSeconds) * msPerSecond,
	}
}

/**
 * Waits until the user approved the device authorization, looking as often as Identity Center
 * allows, and returns the session it signed in to.
 *
 * @throws When the authorization ended before it was approved, or the user denied it.
 */
export async function approvedSession(
	client: RegisteredClient,
	settings: AwsSettings,
	authorization: DeviceAuthorization,
	oidc: SSOOIDCClient,
	now: () => Date,
	wait: (ms: number, abortSignal: AbortSignal) => Promise<void>,
	abortSignal: AbortSignal,
): Promise<StoredSession> {
	let intervalMs = authorization.intervalMs
	for (;;) {
		if (now() >= authorization.expiresAt) throw new Error('The AWS sign-in ended before it was approved. Sign in again.')
		try {
			const token = await oidc.send(
				new CreateTokenCommand({
					clientId: client.clientId,
					clientSecret: client.clientSecret,
					grantType: deviceCodeGrant,
					deviceCode: authorization.deviceCode,
				}),
				{ abortSignal },
			)
			return sessionOf(token, settings, now())
		} catch (error) {
			abortSignal.throwIfAborted()
			if (error instanceof SlowDownException) intervalMs += slowDownStepMs
			else if (!(error instanceof AuthorizationPendingException)) throw error
		}
		try {
			await wait(intervalMs, abortSignal)
		} catch (error) {
			// A stop says why: the timer's own error doesn't.
			abortSignal.throwIfAborted()
			throw error
		}
	}
}

/** The session a token answer hands out. */
export function sessionOf(
	token: { readonly accessToken?: string | undefined; readonly expiresIn?: number | undefined; readonly refreshToken?: string | undefined },
	settings: Pick<AwsSettings, 'ssoRegion' | 'startUrl'>,
	now: Date,
): StoredSession {
	if (token.accessToken === undefined) throw new Error('Identity Center sent no access token.')
	return {
		ssoRegion: settings.ssoRegion,
		startUrl: settings.startUrl,
		accessToken: token.accessToken,
		expiresAt: expiresIn(now, token.expiresIn).toISOString(),
		...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
	}
}
