import { ConnectorName } from '@mesh-flow/protocol'

/**
 * A host tool can't do its work until the user signs in to its connector's service again: there is
 * no session, or the service ended it. Throw it before the tool changes anything, since the runtime
 * waits for the sign-in and then calls the tool again with the same input.
 *
 * ```ts
 * const session = await readSession(credentials, abortSignal)
 * if (session === undefined) throw new SignInNeeded('aws', 'Sign in to AWS: `mesh-flow login aws`.')
 * ```
 */
export class SignInNeeded extends Error {
	override readonly name: string = 'SignInNeeded'
	/** The connector to sign in to, as `mesh-flow login` names it. */
	readonly signIn: ConnectorName

	constructor(connector: string, message = `Sign in to ${connector}: \`mesh-flow login ${connector}\`.`) {
		super(message)
		this.signIn = ConnectorName.parse(connector)
	}
}

/**
 * The connector `error` says the user has to sign in to, if it says so. Checked by its `signIn`
 * field, not by class, since a connector package may bring its own copy of this package.
 */
export function signInOf(error: unknown): ConnectorName | undefined {
	if (!(error instanceof Error) || !('signIn' in error)) return undefined
	const parsed = ConnectorName.safeParse(error.signIn)
	return parsed.success ? parsed.data : undefined
}
