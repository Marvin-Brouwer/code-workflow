import { setTimeout as sleep } from 'node:timers/promises'
import type { ConnectorLoginContext } from '@mesh-flow/gateway'
import type { AwsEndpoints } from './aws-endpoints.mts'
import { awsCredentialNames, readAwsSettings } from './aws-settings.mts'
import { approvedSession, oidcClient, registeredClient, startDeviceAuthorization } from './oidc.mts'
import { writeStored } from './stored-session.mts'

/** What {@link signIn} takes besides the login context: for a test, fakes and a clock of its own. */
export interface SignInOptions {
	readonly endpoints?: AwsEndpoints
	readonly now?: () => Date
	/** Waits between looks for the approval. Default: a timer. */
	readonly wait?: (ms: number, abortSignal: AbortSignal) => Promise<void>
}

/**
 * Signs in to IAM Identity Center with the device flow and keeps the session in the credential
 * store: registers this engine once, shows the user the URL and code, and waits until they approve.
 * What `mesh-flow login aws` runs. The tokens never leave the host.
 *
 * @throws When the AWS settings are missing, and when the sign-in ended or was denied before it
 * was approved.
 */
export async function signIn(context: ConnectorLoginContext, options: SignInOptions = {}): Promise<void> {
	const { credentials, show, abortSignal } = context
	const now = options.now ?? (() => new Date())
	const wait = options.wait ?? ((ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }))
	const settings = await readAwsSettings(credentials, abortSignal)
	const oidc = oidcClient(settings, options.endpoints ?? {})
	try {
		const client = await registeredClient(credentials, settings, oidc, now, abortSignal)
		const authorization = await startDeviceAuthorization(client, settings, oidc, now, abortSignal)
		show({ url: authorization.url, code: authorization.code, expiresAt: authorization.expiresAt })
		const session = await approvedSession(client, settings, authorization, oidc, now, wait, abortSignal)
		await writeStored(credentials, awsCredentialNames.session, session, abortSignal)
	} finally {
		oidc.destroy()
	}
}
