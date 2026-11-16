import { SignInNeededError } from '@mesh-flow/gateway'

/** What to run to sign in to AWS. */
const signInCommand = '`mesh-flow login aws`'

/**
 * AWS can't be reached until the user signs in again: there was no session, or Identity Center
 * ended it, and what the host derived from it ran out. A host tool that throws it makes the run
 * wait for `mesh-flow login aws`, or the sign-in `mesh-flow show <run>` points to, and call again.
 */
export class AwsSignInNeededError extends SignInNeededError {
	override readonly name = 'AwsSignInNeededError'

	constructor(message = `Sign in to AWS: ${signInCommand}.`) {
		super('aws', message)
	}
}

/** The error for a session Identity Center ended. */
export function sessionEnded(): AwsSignInNeededError {
	return new AwsSignInNeededError(`The AWS session ended. Sign in again: ${signInCommand}.`)
}
