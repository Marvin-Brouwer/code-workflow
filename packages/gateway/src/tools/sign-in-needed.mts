import { ConnectorName } from '@mesh-flow/protocol'

/**
 * A host tool can't do its work until the user signs in to its connector's service again: there is
 * no session, or the service ended it. Throw it before the tool changes anything, since the runtime
 * waits for the sign-in and then calls the tool again with the same input.
 *
 * ```ts
 * const session = await readSession(credentials, abortSignal)
 * if (session === undefined) throw new SignInNeededError('aws', 'Sign in to AWS: `mesh-flow login aws`.')
 * ```
 */
export class SignInNeededError extends Error {
	override readonly name: string = 'SignInNeededError'
	/** The connector to sign in to, as `mesh-flow login` names it. */
	readonly signInTo: ConnectorName

	constructor(connector: string, message = `Sign in to ${connector}: \`mesh-flow login ${connector}\`.`) {
		super(message)
		this.signInTo = ConnectorName.parse(connector)
	}
}

/**
 * The connector `error` says the user has to sign in to, if it says so. Checked by its `signInTo`
 * field, not by class, since a connector package may bring its own copy of this package.
 */
export function signInOf(error: unknown): ConnectorName | undefined {
	if (!(error instanceof Error) || !('signInTo' in error)) return undefined
	const parsed = ConnectorName.safeParse(error.signInTo)
	return parsed.success ? parsed.data : undefined
}
