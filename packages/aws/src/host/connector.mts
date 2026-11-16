import { connectorHost, type ConnectorHost, type CredentialStore } from '@mesh-flow/gateway'
import { awsConnector as name } from '../registries/code-artifact-repository.mts'
import type { AwsEndpoints } from './aws-endpoints.mts'
import { awsHostTools } from './aws-host-tools.mts'
import { openAwsSession, type AwsSession } from './aws-session.mts'
import { readAwsSettings } from './aws-settings.mts'
import { codeArtifactFetch } from './code-artifact-fetch.mts'
import { signIn, type SignInOptions } from './sign-in.mts'

/** What {@link awsConnectorHost} works with, for a test against fakes. */
export interface AwsConnectorOptions extends SignInOptions {
	/** For a test: where the AWS clients go. */
	readonly endpoints?: AwsEndpoints
}

/**
 * The AWS connector's host half: the host tools and the CodeArtifact registries, on one session for
 * each credential store the engine gives it, and the IAM Identity Center sign-in. `options` is for
 * a test against fakes; the engine loads {@link connector}.
 */
export function awsConnectorHost(options: AwsConnectorOptions = {}): ConnectorHost {
	const sessions = new WeakMap<CredentialStore, AwsSession>()
	const sessionOf = (credentials: CredentialStore) => {
		const known = sessions.get(credentials)
		if (known !== undefined) return known
		const opened = openAwsSession({ credentials, ...options })
		sessions.set(credentials, opened)
		return opened
	}
	return connectorHost(name, ({ credentials }) => awsHostTools(sessionOf(credentials)), {
		login: (context) => signIn(context, options),
		registries: ({ credentials }) => codeArtifactFetch(sessionOf(credentials)),
		async missingSettings(credentials, abortSignal) {
			try {
				await readAwsSettings(credentials, abortSignal)
				return []
			} catch (error) {
				return [error instanceof Error ? error.message : String(error)]
			}
		},
	})
}

/**
 * The AWS connector's host half, as `mesh-flow connector add @mesh-flow/aws` loads it: the host
 * tools and the CodeArtifact registries, on one session per engine, and the IAM Identity Center
 * sign-in for `mesh-flow login aws` and for runs that wait for one.
 *
 * @example
 * ```sh
 * mesh-flow connector add @mesh-flow/aws
 * echo 'https://example.awsapps.com/start' | mesh-flow credential set aws/start-url
 * echo 'eu-west-1' | mesh-flow credential set aws/sso-region
 * echo '123456789012' | mesh-flow credential set aws/account
 * echo 'Developer' | mesh-flow credential set aws/role
 * mesh-flow login aws
 * ```
 */
export const connector: ConnectorHost = awsConnectorHost()
