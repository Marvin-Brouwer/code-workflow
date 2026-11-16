import type { CredentialReader, CredentialStore } from '@mesh-flow/gateway'
import { z } from 'zod'
import { awsCredentialNames, type AwsSettings } from './aws-settings.mts'
import { parseStored, readStored, serializeStored, writeStored } from './stored-record.mts'

/**
 * The Identity Center session the user signed in to: the access token the access portal takes, the
 * refresh token that renews it while the session lives, and the client registration both were
 * handed to, since only that client can use the refresh token.
 */
export const StoredSession = z.object({
	ssoRegion: z.string(),
	startUrl: z.string(),
	clientId: z.string(),
	clientSecret: z.string(),
	accessToken: z.string(),
	expiresAt: z.iso.datetime(),
	refreshToken: z.string().optional(),
})
export type StoredSession = z.infer<typeof StoredSession>

/** Where a session was signed in to: it holds only for the same settings. */
type SessionSettings = Pick<AwsSettings, 'ssoRegion' | 'startUrl'>

function isFor(session: StoredSession, settings: SessionSettings): boolean {
	return session.ssoRegion === settings.ssoRegion && session.startUrl === settings.startUrl
}

/** The session, when it was signed in to for these settings. */
export async function readSession(
	credentials: CredentialReader,
	settings: SessionSettings,
	abortSignal: AbortSignal,
): Promise<StoredSession | undefined> {
	const session = await readStored(credentials, awsCredentialNames.session, StoredSession, abortSignal)
	return session !== undefined && isFor(session, settings) ? session : undefined
}

/** Keeps the session a sign-in handed out, in place of any other. */
export function keepSession(credentials: CredentialStore, session: StoredSession, abortSignal: AbortSignal): Promise<void> {
	return writeStored(credentials, awsCredentialNames.session, StoredSession, session, abortSignal)
}

/**
 * Keeps `renewed` in place of `renewing`, unless the session changed since it was read, such as by
 * `mesh-flow login aws` in another process: then that one stays. Resolves whether it was kept.
 */
export function renewSession(
	credentials: CredentialStore,
	renewing: StoredSession,
	renewed: StoredSession,
	abortSignal: AbortSignal,
): Promise<boolean> {
	return credentials.update(
		awsCredentialNames.session,
		(current) => {
			const stored = parseStored(current, StoredSession)
			if (stored === undefined || !isFor(stored, renewing) || stored.refreshToken !== renewing.refreshToken) return undefined
			return serializeStored(StoredSession, renewed)
		},
		abortSignal,
	)
}
