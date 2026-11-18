import type { CredentialStore } from '../credentials/credential-store.mts'

/** Where the user signs in, as a device flow hands it out: open the URL, then enter the code. */
export interface LoginPrompt {
	/** The page to open, with the code filled in when the service gives one. */
	readonly url: string
	/** The code to enter, or to check against the one the page shows. */
	readonly code: string
	/** When the code stops working, and the sign-in has to start again. */
	readonly expiresAt: Date
}

/** What a connector's sign-in gets. */
export interface ConnectorLoginContext {
	/**
	 * The gateway's credentials, to read the connector's settings and keep the session it signs in
	 * to. Unlike a host tool's, these can be written.
	 */
	readonly credentials: CredentialStore
	/** Shows the user where to sign in. Called once the service has handed out a code. */
	readonly show: (prompt: LoginPrompt) => void
	/** Stops waiting for the user, such as on Ctrl+C. */
	readonly abortSignal: AbortSignal
}

/**
 * Signs the user in to a connector's service and keeps the session in the credential store, for
 * `mesh-flow login <connector>`. Resolves once the user approved; until then it waits.
 */
export type ConnectorLogin = (context: ConnectorLoginContext) => Promise<void>
