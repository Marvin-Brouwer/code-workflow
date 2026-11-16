import { hostTool, type CredentialStore, type HostTool } from '@mesh-flow/gateway'
import { checkSession } from '../tools/session-tools.mts'
import type { AwsEndpoints } from './aws-endpoints.mts'
import { openAwsSession } from './aws-session.mts'

/** What the AWS host tools work on. */
export interface AwsHostToolsOptions {
	/** The connector's own credentials: the settings, and the session it renews. */
	readonly credentials: CredentialStore
	/** For a test: where the AWS clients go. */
	readonly endpoints?: AwsEndpoints
	/** For a test: the clock. */
	readonly now?: () => Date
}

/**
 * The AWS host tools, sharing one session. Each throws an `AwsSignInNeeded` before it does
 * anything when the user has to sign in, so the run waits for the sign-in and calls again.
 */
export function awsHostTools(options: AwsHostToolsOptions): HostTool[] {
	const session = openAwsSession(options)
	return [
		hostTool(checkSession, async (_input, { abortSignal }) => {
			await session.roleCredentials(abortSignal)
			return { signedIn: true as const }
		}),
	]
}
