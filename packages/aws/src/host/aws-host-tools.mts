import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { checkSession } from '../tools/session-tools.mts'
import type { AwsSession } from './aws-session.mts'

/**
 * The AWS host tools, on `session`. Each throws an `AwsSignInNeeded` before it does anything when
 * the user has to sign in, so the run waits for the sign-in and calls again.
 */
export function awsHostTools(session: AwsSession): HostTool[] {
	return [
		hostTool(checkSession, async (_input, { abortSignal }) => {
			await session.roleCredentials(abortSignal)
			return { signedIn: true as const }
		}),
	]
}
