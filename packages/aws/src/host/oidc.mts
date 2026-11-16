import { RegisterClientCommand, SSOOIDCClient } from '@aws-sdk/client-sso-oidc'
import { endpointOption, type AwsEndpoints } from './aws-endpoints.mts'
import type { AwsSettings } from './aws-settings.mts'
import type { StoredSession } from './stored-session.mts'

/** The OAuth grant a device authorization ends in. */
export const deviceCodeGrant = 'urn:ietf:params:oauth:grant-type:device_code'

/** The OAuth grant that renews an access token. */
export const refreshTokenGrant = 'refresh_token'

/** The scope that lets a token fetch role credentials from the access portal. */
const accountAccessScope = 'sso:account:access'

/** How the engine names itself to Identity Center. */
const clientName = 'mesh-flow'

const msPerSecond = 1000

/** A client registration with Identity Center: what a sign-in and the refreshes after it are made as. */
export interface RegisteredClient {
	readonly clientId: string
	readonly clientSecret: string
}

/** Identity Center's OIDC service in the settings' region. */
export function oidcClient(settings: AwsSettings, endpoints: AwsEndpoints): SSOOIDCClient {
	return new SSOOIDCClient({ region: settings.ssoRegion, ...endpointOption(endpoints.oidc) })
}

/**
 * When something that lasts `seconds` from `now` ends.
 *
 * @throws When Identity Center didn't say how long, rather than take it as already over.
 */
export function expiresIn(now: Date, seconds: number | undefined, what: string): Date {
	if (seconds === undefined) throw new Error(`Identity Center didn't say how long ${what} lasts.`)
	return new Date(now.getTime() + seconds * msPerSecond)
}

/**
 * Registers the engine with Identity Center, as a public client allowed the device flow and
 * refresh tokens. A sign-in makes a new one, so the registration, which lasts about 90 days,
 * always outlasts the session its refresh token renews.
 */
export async function registerClient(oidc: SSOOIDCClient, abortSignal: AbortSignal): Promise<RegisteredClient> {
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
	return { clientId: registered.clientId, clientSecret: registered.clientSecret }
}

/** What Identity Center's token answer hands out. */
export interface TokenAnswer {
	readonly accessToken?: string | undefined
	readonly expiresIn?: number | undefined
	readonly refreshToken?: string | undefined
}

/** The session a token answer for `client` hands out. */
export function sessionOf(
	token: TokenAnswer,
	settings: Pick<AwsSettings, 'ssoRegion' | 'startUrl'>,
	client: RegisteredClient,
	now: Date,
): StoredSession {
	if (token.accessToken === undefined) throw new Error('Identity Center sent no access token.')
	return {
		ssoRegion: settings.ssoRegion,
		startUrl: settings.startUrl,
		clientId: client.clientId,
		clientSecret: client.clientSecret,
		accessToken: token.accessToken,
		expiresAt: expiresIn(now, token.expiresIn, 'the access token').toISOString(),
		...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
	}
}
