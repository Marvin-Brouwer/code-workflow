import { CodeartifactClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-codeartifact'
import {
	ExpiredTokenException,
	InvalidClientException,
	InvalidGrantException,
	UnauthorizedClientException,
	CreateTokenCommand,
} from '@aws-sdk/client-sso-oidc'
import { GetRoleCredentialsCommand, SSOClient, UnauthorizedException } from '@aws-sdk/client-sso'
import { oneAtATime, type CredentialStore } from '@mesh-flow/gateway'
import type { AwsEndpoints } from './aws-endpoints.mts'
import { awsCredentialNames, readAwsSettings, type AwsSettings } from './aws-settings.mts'
import { oidcClient, refreshTokenGrant, registeredClient, renewAheadMs, sessionOf } from './oidc.mts'
import { AwsSignInNeeded } from './sign-in-needed.mts'
import { readSession, writeStored } from './stored-session.mts'

/** Temporary credentials for the role in the settings. Kept in memory only. */
export interface RoleCredentials {
	readonly accessKeyId: string
	readonly secretAccessKey: string
	readonly sessionToken: string
	readonly expiresAt: Date
}

/** A CodeArtifact domain, and the account and region it is in. */
export interface CodeArtifactDomain {
	readonly domain: string
	/** The account that owns the domain. */
	readonly owner: string
	readonly region: string
}

/** A CodeArtifact authorization token, for a package manager's requests to the domain's repositories. */
export interface CodeArtifactToken {
	readonly token: string
	readonly expiresAt: Date
}

/** Whether the host can reach AWS without asking the user. */
export type AwsSessionStatus = 'signed-in' | 'sign-in-needed'

/**
 * What the AWS host tools work with: role credentials and CodeArtifact tokens from the Identity
 * Center session the user signed in to. Each is fetched when it's first needed and again when it
 * nears its end, while the session lives; once Identity Center ends the session, the last ones are
 * used until they run out, so a restore that is under way isn't cut off.
 */
export interface AwsSession {
	/**
	 * @throws An {@link AwsSignInNeeded} when there is no session and nothing derived from one is left.
	 */
	readonly roleCredentials: (abortSignal: AbortSignal) => Promise<RoleCredentials>
	/**
	 * A token for the domain, fetched with the role credentials and lasting as long as they do, so
	 * the two are renewed together.
	 *
	 * @throws An {@link AwsSignInNeeded} as {@link AwsSession.roleCredentials} does.
	 */
	readonly codeArtifactToken: (domain: CodeArtifactDomain, abortSignal: AbortSignal) => Promise<CodeArtifactToken>
	/** Whether role credentials can be had without signing in, fetching them if needed. */
	readonly status: (abortSignal: AbortSignal) => Promise<AwsSessionStatus>
}

/** What {@link openAwsSession} works on. */
export interface AwsSessionOptions {
	/** The gateway's credentials: the settings, and the session, which is renewed in place. */
	readonly credentials: CredentialStore
	/** For a test: where the AWS clients go. */
	readonly endpoints?: AwsEndpoints
	/** For a test: the clock. */
	readonly now?: () => Date
}

/** Identity Center's answers that mean its session is over: a new sign-in is the only way on. */
function endsSession(error: unknown): boolean {
	return (
		error instanceof InvalidGrantException ||
		error instanceof ExpiredTokenException ||
		error instanceof UnauthorizedClientException ||
		error instanceof InvalidClientException ||
		error instanceof UnauthorizedException
	)
}

/** Whether something that ends at `expiresAt` still holds for a while at `now`. */
function lastsBeyondRenewal(expiresAt: Date, now: Date): boolean {
	return expiresAt.getTime() - renewAheadMs > now.getTime()
}

/** Opens the engine home's AWS session. One per gateway: every run shares it. */
export function openAwsSession(options: AwsSessionOptions): AwsSession {
	const { credentials } = options
	const endpoints = options.endpoints ?? {}
	const now = options.now ?? (() => new Date())
	const turns = oneAtATime()
	let roleCredentials: RoleCredentials | undefined
	const tokens = new Map<string, { readonly credentials: RoleCredentials; readonly token: CodeArtifactToken }>()

	/** The session's access token, renewed with its refresh token when it nears its end. */
	const accessToken = async (settings: AwsSettings, abortSignal: AbortSignal): Promise<string> => {
		const session = await readSession(credentials, settings, abortSignal)
		if (session === undefined) throw new AwsSignInNeeded()
		if (lastsBeyondRenewal(new Date(session.expiresAt), now())) return session.accessToken
		if (session.refreshToken === undefined) throw new AwsSignInNeeded('The AWS session ended. Sign in again: `mesh-flow login aws`.')
		const oidc = oidcClient(settings, endpoints)
		try {
			const client = await registeredClient(credentials, settings, oidc, now, abortSignal)
			const token = await oidc.send(
				new CreateTokenCommand({
					clientId: client.clientId,
					clientSecret: client.clientSecret,
					grantType: refreshTokenGrant,
					refreshToken: session.refreshToken,
				}),
				{ abortSignal },
			)
			// Identity Center may hand out a new refresh token, and then the old one no longer works.
			const renewed = sessionOf({ ...token, refreshToken: token.refreshToken ?? session.refreshToken }, settings, now())
			await writeStored(credentials, awsCredentialNames.session, renewed, abortSignal)
			return renewed.accessToken
		} catch (error) {
			if (endsSession(error)) throw new AwsSignInNeeded('The AWS session ended. Sign in again: `mesh-flow login aws`.')
			throw error
		} finally {
			oidc.destroy()
		}
	}

	const fetchRoleCredentials = async (abortSignal: AbortSignal): Promise<RoleCredentials> => {
		const settings = await readAwsSettings(credentials, abortSignal)
		const sso = new SSOClient({ region: settings.ssoRegion, ...(endpoints.sso === undefined ? {} : { endpoint: endpoints.sso }) })
		try {
			const answer = await sso.send(
				new GetRoleCredentialsCommand({
					accessToken: await accessToken(settings, abortSignal),
					accountId: settings.account,
					roleName: settings.role,
				}),
				{ abortSignal },
			)
			const fetched = answer.roleCredentials
			if (
				fetched?.accessKeyId === undefined ||
				fetched.secretAccessKey === undefined ||
				fetched.sessionToken === undefined ||
				fetched.expiration === undefined
			)
				throw new Error(`The access portal sent no credentials for ${settings.role} in ${settings.account}.`)
			return {
				accessKeyId: fetched.accessKeyId,
				secretAccessKey: fetched.secretAccessKey,
				sessionToken: fetched.sessionToken,
				expiresAt: new Date(fetched.expiration),
			}
		} catch (error) {
			if (endsSession(error)) throw new AwsSignInNeeded('The AWS session ended. Sign in again: `mesh-flow login aws`.')
			throw error
		} finally {
			sso.destroy()
		}
	}

	const currentRoleCredentials = (abortSignal: AbortSignal): Promise<RoleCredentials> =>
		turns('role-credentials', abortSignal, async () => {
			const kept = roleCredentials
			if (kept !== undefined && lastsBeyondRenewal(kept.expiresAt, now())) return kept
			try {
				roleCredentials = await fetchRoleCredentials(abortSignal)
				return roleCredentials
			} catch (error) {
				// The session is over: what was derived from it holds until it runs out.
				if (error instanceof AwsSignInNeeded && kept !== undefined && kept.expiresAt > now()) return kept
				throw error
			}
		})

	const codeArtifactToken = (domain: CodeArtifactDomain, abortSignal: AbortSignal): Promise<CodeArtifactToken> => {
		const key = `${domain.region}/${domain.owner}/${domain.domain}`
		return turns(`codeartifact/${key}`, abortSignal, async () => {
			const role = await currentRoleCredentials(abortSignal)
			const kept = tokens.get(key)
			if (kept?.credentials === role && kept.token.expiresAt > now()) return kept.token
			const client = new CodeartifactClient({
				region: domain.region,
				credentials: { accessKeyId: role.accessKeyId, secretAccessKey: role.secretAccessKey, sessionToken: role.sessionToken },
				...(endpoints.codeArtifact === undefined ? {} : { endpoint: endpoints.codeArtifact }),
			})
			try {
				// Duration 0: the token lasts as long as the credentials it is fetched with.
				const answer = await client.send(
					new GetAuthorizationTokenCommand({ domain: domain.domain, domainOwner: domain.owner, durationSeconds: 0 }),
					{ abortSignal },
				)
				if (answer.authorizationToken === undefined) throw new Error(`CodeArtifact sent no token for ${domain.domain}.`)
				const token = { token: answer.authorizationToken, expiresAt: answer.expiration ?? role.expiresAt }
				tokens.set(key, { credentials: role, token })
				return token
			} finally {
				client.destroy()
			}
		})
	}

	return Object.freeze<AwsSession>({
		roleCredentials: currentRoleCredentials,
		codeArtifactToken,
		async status(abortSignal) {
			try {
				await currentRoleCredentials(abortSignal)
				return 'signed-in'
			} catch (error) {
				if (error instanceof AwsSignInNeeded) return 'sign-in-needed'
				throw error
			}
		},
	})
}
