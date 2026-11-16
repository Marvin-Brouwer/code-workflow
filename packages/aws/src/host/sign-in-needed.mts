/**
 * AWS can't be reached until the user signs in again: there was no session, or Identity Center
 * ended it, and what the host derived from it ran out. Checked by its `signInNeeded` field, as
 * `isTransient` checks `transient`, since a connector may bring its own copy of this package.
 */
export class AwsSignInNeeded extends Error {
	override readonly name = 'AwsSignInNeeded'
	readonly signInNeeded = true

	constructor(message = 'Sign in to AWS: `mesh-flow login aws`.') {
		super(message)
	}
}

/** Whether `error` says the user has to sign in to AWS again. */
export function isSignInNeeded(error: unknown): boolean {
	return error instanceof Error && 'signInNeeded' in error && error.signInNeeded === true
}
