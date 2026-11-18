import { sleep } from '@mesh-flow/duration'
import type { ConnectorSignInContext } from '@mesh-flow/gateway'
import type { AwsEndpoints } from './aws-endpoints.mts'
import { readAwsSettings } from './aws-settings.mts'
import { approvedSession, startDeviceAuthorization, type Wait } from './device-authorization.mts'
import { oidcClient, registerClient } from './oidc.mts'
import { keepSession } from './stored-session.mts'

/** What {@link signIn} takes besides the login context: for a test, fakes and a clock of its own. */
export interface SignInOptions {
	/** For a test: where the AWS clients go. */
	readonly endpoints?: AwsEndpoints
	/** For a test: the clock. */
	readonly now?: () => Date
	/** For a test: waits between looks for the approval. Default: a timer. */
	readonly wait?: Wait
}

/** Waits on a timer that stops with `abortSignal`. */
const timerWait: Wait = sleep

/**
 * Signs in to IAM Identity Center with the device flow and keeps the session in the credential
 * store: registers this engine, shows the user the URL and code, and waits until they approve.
 * What `mesh-flow login aws` runs. The tokens never leave the host.
 *
 * @throws When the AWS settings are missing, and when the sign-in ended or was denied before it
 * was approved.
 */
export async function signIn(context: ConnectorSignInContext, options: SignInOptions = {}): Promise<void> {
	const { credentials, show, abortSignal } = context
	const now = options.now ?? (() => new Date())
	const settings = await readAwsSettings(credentials, abortSignal)
	const oidc = oidcClient(settings, options.endpoints ?? {})
	try {
		const client = await registerClient(oidc, abortSignal)
		const authorization = await startDeviceAuthorization(client, settings, oidc, now, abortSignal)
		show({ url: authorization.url, code: authorization.code, expiresAt: authorization.expiresAt })
		const session = await approvedSession(client, settings, authorization, oidc, now, options.wait ?? timerWait, abortSignal)
		await keepSession(credentials, session, abortSignal)
	} finally {
		oidc.destroy()
	}
}
