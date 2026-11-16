/** What to run to sign in to AWS. */
const signInCommand = '`mesh-flow login aws`'

/**
 * AWS can't be reached until the user signs in again: there was no session, or Identity Center
 * ended it, and what the host derived from it ran out. Checked by its `signInNeeded` field, as
 * `isTransient` checks `transient`, since a connector may bring its own copy of this package.
 */
export class AwsSignInNeededError extends Error {
	override readonly name = 'AwsSignInNeededError'
	readonly signInNeeded = true

	constructor(message = `Sign in to AWS: ${signInCommand}.`) {
		super(message)
	}
}

/** The error for a session Identity Center ended. */
export function sessionEnded(): AwsSignInNeededError {
	return new AwsSignInNeededError(`The AWS session ended. Sign in again: ${signInCommand}.`)
}

/** Whether `error` says the user has to sign in to AWS again. */
export function isSignInNeeded(error: unknown): boolean {
	return error instanceof Error && 'signInNeeded' in error && error.signInNeeded === true
}
