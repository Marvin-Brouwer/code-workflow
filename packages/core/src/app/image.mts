import type { PackageRegistry, SandboxDescription } from '@mesh-flow/protocol'

/** The sandbox of {@link image}: an OCI image and what it may use. */
export interface ImageOptions {
	/** An OCI image reference with Node.js 26.18 or newer, such as `node:26-slim`. */
	readonly name: string
	/** The CPUs the sandbox gets. Default: 2. */
	readonly cpus?: number
	/** The sandbox's memory, in MB. Default: 2048. */
	readonly memoryMb?: number
	/**
	 * The public package registries a run restores from: `nuget` (nuget.org) and `npm` (the npm
	 * registry). Default: none.
	 */
	readonly registries?: readonly PackageRegistry[]
}

const defaultCpus = 2
const defaultMemoryMb = 2048

/**
 * Runs the app in a sandbox made from an OCI image. The engine adds the built app; the image only
 * needs Node.js.
 *
 * The sandbox has no network. Package managers in it, such as `npm ci` or `dotnet restore`, still
 * work for the registries listed here: the run serves them a proxy on `HTTPS_PROXY`, and every
 * fetch through it is a call to the gateway, which fetches the package on the host. Any other host
 * is refused.
 *
 * ```ts
 * export default defineMeshFlow({
 * 	sandbox: image({ name: 'node:26-slim', memoryMb: 4096, registries: ['npm'] }),
 * 	workflows: [userTrigger(develop)],
 * })
 * ```
 */
export function image(options: ImageOptions): SandboxDescription {
	return Object.freeze({
		image: options.name,
		cpus: options.cpus ?? defaultCpus,
		memoryMb: options.memoryMb ?? defaultMemoryMb,
		registries: Object.freeze([...new Set(options.registries ?? [])]),
	})
}
