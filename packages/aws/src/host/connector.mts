import { connectorHost, type ConnectorHost } from '@mesh-flow/gateway'
import { signIn } from './sign-in.mts'

/**
 * The AWS connector's host half, as `mesh-flow connector add @mesh-flow/aws` loads it. It signs in
 * to IAM Identity Center for `mesh-flow login aws`. Its host tools, such as CodeArtifact fetches,
 * come with the registry shim.
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
// Wrapped, not `{ login: signIn }`: the engine's login must not reach the test seams in `SignInOptions`.
export const connector: ConnectorHost = connectorHost('aws', () => [], { login: (context) => signIn(context) })
