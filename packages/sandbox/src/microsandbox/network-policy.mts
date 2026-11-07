import { Destination, NetworkPolicy, Rule } from 'microsandbox'
import type { EgressPolicy } from '../sandbox-spec.mts'

/**
 * The part of microsandbox's network builder this package uses. Its own type is `any` in the
 * SDK's declarations.
 */
export interface NetworkBuilder {
	policy(policy: NetworkPolicy): unknown
}

/** Deny by default; DNS and each allowed host on top. No hosts means no network. */
export function networkPolicy(egress: EgressPolicy): NetworkPolicy {
	if (egress.allow.length === 0) return NetworkPolicy.none()
	return {
		defaultEgress: 'deny',
		// As in the POC that passed. Nothing reaches the VM without a published port anyway.
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
	return egress.allow.length > 0
}
