import { SignInNeeded } from '@mesh-flow/gateway'

/**
 * AWS can't be reached until the user signs in again: there was no session, or Identity Center
 * ended it, and what the host derived from it ran out. A host tool that throws it makes the run
 * wait for `mesh-flow login aws`, or the sign-in `mesh-flow show <run>` points to, and call again.
 */
export class AwsSignInNeeded extends SignInNeeded {
	override readonly name = 'AwsSignInNeeded'

	constructor(message = 'Sign in to AWS: `mesh-flow login aws`.') {
		super('aws', message)
	}
}
