import type { CredentialReader, CredentialStore } from '@mesh-flow/gateway'
import { z } from 'zod'
import { awsCredentialNames } from './aws-settings.mts'

/**
 * This engine's registration with Identity Center, for the region and access portal it was made
 * for. It lasts about 90 days; a new one is made once it ends, or once the settings change.
 */
export const RegisteredClient = z.object({
	ssoRegion: z.string(),
	startUrl: z.string(),
	clientId: z.string(),
	clientSecret: z.string(),
	expiresAt: z.iso.datetime(),
})
export type RegisteredClient = z.infer<typeof RegisteredClient>

/**
 * The Identity Center session the user signed in to: the access token the access portal takes,
 * and the refresh token that renews it while the session lives.
 */
export const StoredSession = z.object({
	ssoRegion: z.string(),
	startUrl: z.string(),
	accessToken: z.string(),
	expiresAt: z.iso.datetime(),
	refreshToken: z.string().optional(),
})
export type StoredSession = z.infer<typeof StoredSession>

/** A JSON record kept in the credential store under `name`, or `undefined` when there is none, or it doesn't read. */
export async function readStored<T>(
	credentials: CredentialReader,
	name: string,
	schema: z.ZodType<T>,
	abortSignal: AbortSignal,
): Promise<T | undefined> {
	const text = await credentials.get(name, abortSignal)
	if (text === undefined) return undefined
	try {
		const parsed = schema.safeParse(JSON.parse(text))
		return parsed.success ? parsed.data : undefined
	} catch {
		return undefined
	}
}

/** Keeps a JSON record in the credential store under `name`. */
export function writeStored(credentials: CredentialStore, name: string, value: unknown, abortSignal: AbortSignal): Promise<void> {
	return credentials.set(name, JSON.stringify(value), abortSignal)
}

/** The session, when it was signed in to for these settings. */
export async function readSession(
	credentials: CredentialReader,
	settings: { readonly ssoRegion: string; readonly startUrl: string },
	abortSignal: AbortSignal,
): Promise<StoredSession | undefined> {
	const session = await readStored(credentials, awsCredentialNames.session, StoredSession, abortSignal)
	if (session === undefined || session.ssoRegion !== settings.ssoRegion || session.startUrl !== settings.startUrl) return undefined
	return session
}
