import { Destination, NetworkPolicy, Rule } from 'microsandbox'
import { allowsEgress, type EgressPolicy } from '../sandbox-spec.mts'

/**
 * The part of microsandbox's network builder this package uses. Its own type is `any` in the
 * SDK's declarations.
 */
export interface NetworkBuilder {
	policy(policy: NetworkPolicy): unknown
}

/**
 * Deny by default; DNS and each allowed host on top. No hosts means no network. DNS has to be
 * open for hostname rules to work, which is a way out too, see the README's known gaps.
 */
export function networkPolicy(egress: EgressPolicy): NetworkPolicy {
	if (!allowsEgress(egress)) return NetworkPolicy.none()
	return {
		defaultEgress: 'deny',
		// Ingress only matters for published ports, and this package publishes none. Kept at allow
		// as in the pause POC that passed; deny is untested.
		defaultIngress: 'allow',
		rules: [Rule.allowDns(), ...egress.allow.map((host) => Rule.allowEgress(Destination.domain(host)))],
	}
}

/**
 * Hostname rules only hold for HTTPS when microsandbox can read the request's host, which means
 * it terminates TLS with its own CA. Without that, allowed HTTPS connections are reset. Node in
 * the sandbox needs `--use-system-ca` to trust that CA.
 */
export function needsTlsInterception(egress: EgressPolicy): boolean {
	return allowsEgress(egress)
}
