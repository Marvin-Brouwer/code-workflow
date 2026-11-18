import { NetworkPolicy } from 'microsandbox'

/**
 * The part of microsandbox's network builder this package uses. Its own type is `any` in the
 * SDK's declarations.
 */
export interface NetworkBuilder {
	policy(policy: NetworkPolicy): unknown
}

/** No network at all: a sandbox only has loopback, and nothing from it leaves the VM. */
export function noNetwork(network: NetworkBuilder): unknown {
	return network.policy(NetworkPolicy.none())
}
