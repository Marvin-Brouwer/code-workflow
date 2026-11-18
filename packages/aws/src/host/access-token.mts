import {
	CreateTokenCommand,
	ExpiredTokenException,
	InvalidClientException,
	InvalidGrantException,
	UnauthorizedClientException,
} from '@aws-sdk/client-sso-oidc'
import { duration } from '@mesh-flow/duration'
import { untilAborted, type CredentialStore } from '@mesh-flow/gateway'
import type { AwsEndpoints } from './aws-endpoints.mts'
import type { AwsSettings } from './aws-settings.mts'
import { oidcClient, refreshTokenGrant, sessionOf } from './oidc.mts'
import { lastsBeyondRenewal } from './renewal.mts'
import { AwsSignInNeededError, sessionEnded } from './sign-in-needed.mts'
import { readSession, renewSession, type StoredSession } from './stored-session.mts'

/**
 * How long each half of a renewal of the session may take: asking Identity Center, and keeping
 * what it handed out. It runs on signals of its own, not a caller's: once Identity Center hands out
 * a new refresh token the old one no longer works, so a renewal that one caller stops halfway would
 * lose the session for every run.
 */
const renewalTimeout = duration.of('1m')

/** Identity Center's answers that mean its session is over: a new sign-in is the only way on. */
function endsSession(error: unknown): boolean {
	return (
		error instanceof InvalidGrantException ||
		error instanceof ExpiredTokenException ||
		error instanceof UnauthorizedClientException ||
		error instanceof InvalidClientException
	)
}

/** A renewal of the session under way, and the refresh token it renews with. */
interface Renewal {
	readonly refreshToken: string | undefined
	readonly accessToken: Promise<string>
}

/** The session's access token, renewed when it nears its end, or when the portal turned `refused` down. */
export type SessionAccessToken = (settings: AwsSettings, abortSignal: AbortSignal, refused?: string) => Promise<string>

/** What {@link sessionAccessTokens} works on. */
export interface SessionAccessTokensOptions {
	readonly credentials: CredentialStore
	readonly endpoints: AwsEndpoints
	readonly now: () => Date
}

/**
 * Hands out the session's access token, renewing it with the refresh token when needed. One
 * renewal at a time per refresh token: a caller that comes while one runs, even one a stopped
 * caller left, waits for it rather than renew with the same refresh token.
 */
export function sessionAccessTokens({ credentials, endpoints, now }: SessionAccessTokensOptions): SessionAccessToken {
	let renewal: Renewal | undefined

	/** The access token that is kept once the session is renewed: the renewed one, unless a sign-in came between. */
	const keptAccessToken = async (settings: AwsSettings, session: StoredSession, renewed: StoredSession): Promise<string> => {
		const keepAbortSignal = renewalTimeout.toAbortSignal()
		if (await renewSession(credentials, session, renewed, keepAbortSignal)) return renewed.accessToken
		// The user signed in again meanwhile: that session counts.
		const current = await readSession(credentials, settings, keepAbortSignal)
		if (current === undefined) throw new AwsSignInNeededError()
		return current.accessToken
	}

	/** The access token of a session a sign-in stored since `session` was read, if there is one. */
	const signedInSince = async (settings: AwsSettings, session: StoredSession): Promise<string | undefined> => {
		const current = await readSession(credentials, settings, renewalTimeout.toAbortSignal())
		return current !== undefined && current.refreshToken !== session.refreshToken ? current.accessToken : undefined
	}

	/** Renews the session with its refresh token on signals of its own, and resolves the access token that counts afterwards. */
	const renewAccessToken = async (settings: AwsSettings, session: StoredSession): Promise<string> => {
		if (session.refreshToken === undefined) throw sessionEnded()
		const oidc = oidcClient(settings, endpoints)
		let renewed: StoredSession
		try {
			const token = await oidc.send(
				new CreateTokenCommand({
					clientId: session.clientId,
					clientSecret: session.clientSecret,
					grantType: refreshTokenGrant,
					refreshToken: session.refreshToken,
				}),
				{ abortSignal: renewalTimeout.toAbortSignal() },
			)
			// Identity Center may hand out a new refresh token, and then the old one no longer works.
			renewed = sessionOf({ ...token, refreshToken: token.refreshToken ?? session.refreshToken }, settings, session, now())
		} catch (error) {
			if (!endsSession(error)) throw error
			// Refused, perhaps because a sign-in in another process replaced the session meanwhile.
			const signedIn = await signedInSince(settings, session)
			if (signedIn === undefined) throw sessionEnded()
			return signedIn
		} finally {
			oidc.destroy()
		}
		// What Identity Center handed out is kept on a signal of its own, so a slow answer can't cost the write.
		return keptAccessToken(settings, session, renewed)
	}

	/** Starts a renewal and remembers it as the one under way until it settles, so a later caller with the same refresh token waits for it. */
	const startRenewal = (settings: AwsSettings, session: StoredSession): Renewal => {
		const started: Renewal = { refreshToken: session.refreshToken, accessToken: renewAccessToken(settings, session) }
		const forget = () => {
			if (renewal === started) renewal = undefined
		}
		started.accessToken.then(forget, forget)
		renewal = started
		return started
	}

	return async (settings, abortSignal, refused) => {
		const session = await readSession(credentials, settings, abortSignal)
		if (session === undefined) throw new AwsSignInNeededError()
		if (session.accessToken !== refused && lastsBeyondRenewal(new Date(session.expiresAt), now())) return session.accessToken
		const underWay = renewal?.refreshToken === session.refreshToken ? renewal : undefined
		return untilAborted((underWay ?? startRenewal(settings, session)).accessToken, abortSignal)
	}
}
