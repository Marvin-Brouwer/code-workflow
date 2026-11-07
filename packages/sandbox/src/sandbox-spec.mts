import { z } from 'zod'

const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const hostName = new RegExp(`^(?=.{1,253}$)${label}(?:\\.${label})*$`)

/**
 * A host a sandbox may connect to: a lowercase DNS name, matched exactly. No wildcards, ports,
 * IP addresses or CIDR ranges, because not every backend can enforce those the same way.
 */
export const EgressHost = z
	.string()
	.regex(hostName, 'Use a lowercase host name, such as registry.npmjs.org.')
	// Resolvers read digits-only and hex (`0x7f000001`) names as IP addresses.
	.refine(
		(host) => !/^[\d.]+$/.test(host) && !host.split('.').some((part) => part.startsWith('0x')),
		'IP addresses are not allowed; use a host name.',
	)

/**
 * Where a sandbox may connect to, over HTTPS. `registry.npmjs.org` allows that host only, not its
 * subdomains. An empty list means no network at all.
 */
export const EgressPolicy = z.object({
	allow: z.array(EgressHost).readonly(),
})
export type EgressPolicy = z.infer<typeof EgressPolicy>

/** Whether the policy lets the sandbox reach any host at all. */
export function allowsEgress(egress: EgressPolicy): boolean {
	return egress.allow.length > 0
}

/**
 * What a sandbox is made from. Kept with a paused sandbox, because some backends need the same
 * settings again to resume it.
 *
 * @example
 * ```ts
 * const spec: SandboxSpec = {
 * 	image: 'node:22-slim',
 * 	cpus: 2,
 * 	memoryMb: 2048,
 * 	egress: { allow: ['registry.npmjs.org'] },
 * }
 * ```
 */
export const SandboxSpec = z.object({
	/** An OCI image reference. On E2B, the backend maps it to a template. */
	image: z.string().min(1),
	cpus: z.int().positive(),
	memoryMb: z.int().positive(),
	egress: EgressPolicy,
	/** Environment for every command in the sandbox. Never put a credential here. */
	env: z.record(z.string(), z.string()).readonly().optional(),
})
export type SandboxSpec = z.infer<typeof SandboxSpec>
