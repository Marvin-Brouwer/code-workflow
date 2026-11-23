import { z } from 'zod'

/**
 * What a sandbox is made from. Kept with a paused sandbox, because some backends need the same
 * settings again to resume it.
 *
 * A sandbox has no network on any backend: whatever it needs from outside comes from the host,
 * which writes it in or answers it through the sandbox's files.
 *
 * @example
 * ```ts
 * const specification: SandboxSpecification = {
 * 	image: 'node:26-slim',
 * 	cpus: 2,
 * 	memoryMb: 2048,
 * }
 * ```
 */
export const SandboxSpecification = z.object({
	/** An OCI image reference. On E2B, the backend maps it to a template. */
	image: z.string().min(1),
	cpus: z.int().positive(),
	memoryMb: z.int().positive(),
	/** Environment for every command in the sandbox. Never put a credential here. */
	environment: z.record(z.string(), z.string()).readonly().optional(),
})
export type SandboxSpecification = z.infer<typeof SandboxSpecification>
