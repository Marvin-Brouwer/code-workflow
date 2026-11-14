import type { SandboxDescription } from '@mesh-flow/protocol'

/** The sandbox of {@link image}: an OCI image and what it may use. */
export interface ImageOptions {
	/** An OCI image reference with Node.js 26.18 or newer, such as `node:26-slim`. */
	readonly name: string
	/** The CPUs the sandbox gets. Default: 2. */
	readonly cpus?: number
	/** The sandbox's memory, in MB. Default: 2048. */
	readonly memoryMb?: number
	/** The only hosts a run may reach over HTTPS, as lowercase host names. Default: none. */
	readonly egress?: readonly string[]
}

const defaultCpus = 2
const defaultMemoryMb = 2048

/**
 * Runs the app in a sandbox made from an OCI image. The engine adds the built app; the image only
 * needs Node.js:
 *
 * ```ts
 * export default defineMeshFlow({
 * 	sandbox: image({ name: 'node:26-slim', memoryMb: 4096, egress: ['api.example.com'] }),
 * 	workflows: [userTrigger(develop)],
 * })
 * ```
 */
export function image(options: ImageOptions): SandboxDescription {
	return Object.freeze({
		image: options.name,
		cpus: options.cpus ?? defaultCpus,
		memoryMb: options.memoryMb ?? defaultMemoryMb,
		egress: Object.freeze({ allow: Object.freeze([...(options.egress ?? [])]) }),
	})
}
