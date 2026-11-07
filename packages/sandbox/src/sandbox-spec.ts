import { z } from 'zod';

/**
 * Where a sandbox may connect to. Hosts are names, matched exactly: `registry.npmjs.org` allows
 * that host only, not its subdomains. An empty list means no network at all.
 */
export const EgressPolicy = z.object({
    allow: z.array(z.string().min(1)).readonly(),
});
export type EgressPolicy = z.infer<typeof EgressPolicy>;

/**
 * What a sandbox is made from. Kept with a paused sandbox, because some backends need the same
 * settings again to resume it.
 *
 * @example
 * ```ts
 * const spec: SandboxSpec = {
 *     image: 'node:22-slim',
 *     cpus: 2,
 *     memoryMb: 2048,
 *     egress: { allow: ['registry.npmjs.org'] },
 * };
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
});
export type SandboxSpec = z.infer<typeof SandboxSpec>;
