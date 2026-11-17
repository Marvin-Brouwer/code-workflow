import { CodeartifactClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-codeartifact'
import { GetRoleCredentialsCommand, SSOClient, UnauthorizedException } from '@aws-sdk/client-sso'
import { oneAtATime, type CredentialStore } from '@mesh-flow/gateway'
import type { CodeArtifactDomain } from '../registries/code-artifact-repository.mts'
import { sessionAccessTokens } from './access-token.mts'
import { endpointOption, type AwsEndpoints } from './aws-endpoints.mts'
import { readAwsSettings, settingsKey, type AwsSettings } from './aws-settings.mts'
import { lastsBeyondRenewal } from './renewal.mts'
import { AwsSignInNeededError, sessionEnded } from './sign-in-needed.mts'

/** Temporary credentials for the role in the settings. Kept in memory only. */
export interface RoleCredentials {
	readonly accessKeyId: string
	readonly secretAccessKey: string
	readonly sessionToken: string
	readonly expiresAt: Date
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
	 * Credentials for the account and role in the settings, kept in memory and fetched again when
	 * they near their end, or when the settings change.
	 *
	 * @throws An {@link AwsSignInNeededError} when there is no session and nothing derived from one is left.
	 */
	readonly roleCredentials: (abortSignal: AbortSignal) => Promise<RoleCredentials>
	/**
	 * A token for the domain, fetched with the role credentials and lasting as long as they do, so
	 * the two are renewed together.
	 *
	 * @throws An {@link AwsSignInNeededError} as {@link AwsSession.roleCredentials} does.
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

/** The turn every fetch of role credentials takes, so one renewal serves every caller. */
const roleCredentialsTurn = 'role-credentials'

/** CodeArtifact's duration for "as long as the credentials it is fetched with". */
const lastsAsLongAsCredentials = 0

/** CodeArtifact's errors for role credentials it no longer takes, such as when the clocks differ. */
const rejectedCredentials = new Set(['ExpiredTokenException', 'UnrecognizedClientException'])

/** Whether CodeArtifact turned the role credentials down, rather than failed otherwise. */
function rejectsCredentials(error: unknown): boolean {
	return error instanceof Error && rejectedCredentials.has(error.name)
}

/** One key per domain, for its kept token and its turn. */
function domainKey(domain: CodeArtifactDomain): string {
	return `${domain.region}/${domain.owner}/${domain.domain}`
}

/** The key of the turn for a domain's tokens. */
function codeArtifactTurn(key: string): string {
	return `codeartifact/${key}`
}

/** Role credentials, and the settings they were fetched for. */
interface HeldCredentials {
	readonly settingsKey: string
	readonly credentials: RoleCredentials
}

/** A token, and the role credentials it was fetched with. */
interface KeptToken {
	readonly credentials: RoleCredentials
	readonly token: CodeArtifactToken
}

/** Opens the engine home's AWS session. One per gateway: every run shares it. */
export function openAwsSession(options: AwsSessionOptions): AwsSession {
	const { credentials } = options
	const endpoints = options.endpoints ?? {}
	const now = options.now ?? (() => new Date())
	const turns = oneAtATime()
	let held: HeldCredentials | undefined
	const tokens = new Map<string, KeptToken>()
	const accessToken = sessionAccessTokens({ credentials, endpoints, now })

	/** Role credentials from the access portal for `token`. */
	const portalCredentials = async (settings: AwsSettings, token: string, abortSignal: AbortSignal): Promise<RoleCredentials> => {
		const sso = new SSOClient({ region: settings.ssoRegion, ...endpointOption(endpoints.sso) })
		try {
			const answer = await sso.send(
				new GetRoleCredentialsCommand({ accessToken: token, accountId: settings.account, roleName: settings.role }),
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
		} finally {
			sso.destroy()
		}
	}

	const fetchRoleCredentials = async (settings: AwsSettings, abortSignal: AbortSignal): Promise<RoleCredentials> => {
		const token = await accessToken(settings, abortSignal)
		try {
			return await portalCredentials(settings, token, abortSignal)
		} catch (error) {
			if (!(error instanceof UnauthorizedException)) throw error
		}
		// The portal turned the access token down before its time, such as when the clocks differ: renew it once.
		try {
			return await portalCredentials(settings, await accessToken(settings, abortSignal, token), abortSignal)
		} catch (error) {
			if (error instanceof UnauthorizedException) throw sessionEnded()
			throw error
		}
	}

	const currentRoleCredentials = (abortSignal: AbortSignal): Promise<RoleCredentials> =>
		turns(roleCredentialsTurn, abortSignal, async () => {
			const settings = await readAwsSettings(credentials, abortSignal)
			const key = settingsKey(settings)
			const kept = held?.settingsKey === key ? held.credentials : undefined
			if (kept !== undefined && lastsBeyondRenewal(kept.expiresAt, now())) return kept
			try {
				const fetched = await fetchRoleCredentials(settings, abortSignal)
				held = { settingsKey: key, credentials: fetched }
				return fetched
			} catch (error) {
				// Whether the session is over or the portal fails for now, what was fetched holds until it runs out.
				if (!abortSignal.aborted && kept !== undefined && kept.expiresAt > now()) return kept
				throw error
			}
		})

	const fetchToken = async (
		domain: CodeArtifactDomain,
		key: string,
		role: RoleCredentials,
		abortSignal: AbortSignal,
	): Promise<CodeArtifactToken> => {
		const client = new CodeartifactClient({
			region: domain.region,
			credentials: { accessKeyId: role.accessKeyId, secretAccessKey: role.secretAccessKey, sessionToken: role.sessionToken },
			...endpointOption(endpoints.codeArtifact),
		})
		try {
			const answer = await client.send(
				new GetAuthorizationTokenCommand({ domain: domain.domain, domainOwner: domain.owner, durationSeconds: lastsAsLongAsCredentials }),
				{ abortSignal },
			)
			if (answer.authorizationToken === undefined) throw new Error(`CodeArtifact sent no token for ${domain.domain}.`)
			const token = { token: answer.authorizationToken, expiresAt: answer.expiration ?? role.expiresAt }
			tokens.set(key, { credentials: role, token })
			return token
		} finally {
			client.destroy()
		}
	}

	const codeArtifactToken = (domain: CodeArtifactDomain, abortSignal: AbortSignal): Promise<CodeArtifactToken> => {
		const key = domainKey(domain)
		return turns(codeArtifactTurn(key), abortSignal, async () => {
			const role = await currentRoleCredentials(abortSignal)
			const kept = tokens.get(key)
			if (kept?.credentials === role && kept.token.expiresAt > now()) return kept.token
			try {
				return await fetchToken(domain, key, role, abortSignal)
			} catch (error) {
				if (!rejectsCredentials(error)) throw error
			}
			// CodeArtifact turned the role credentials down before their time: fetch new ones once.
			if (held?.credentials === role) held = undefined
			return fetchToken(domain, key, await currentRoleCredentials(abortSignal), abortSignal)
		})
	}

	const status = async (abortSignal: AbortSignal): Promise<AwsSessionStatus> => {
		try {
			await currentRoleCredentials(abortSignal)
			return 'signed-in'
		} catch (error) {
			if (error instanceof AwsSignInNeededError) return 'sign-in-needed'
			throw error
		}
	}

	return Object.freeze<AwsSession>({ roleCredentials: currentRoleCredentials, codeArtifactToken, status })
}
