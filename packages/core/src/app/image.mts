import { uniqueRegistries, type PackageRegistry, type SandboxDescription } from '@mesh-flow/protocol'

/** The sandbox of {@link image}: an OCI image and what it may use. */
export interface ImageOptions {
	/** An OCI image reference with Node.js 26.18 or newer, such as `node:26-slim`. */
	readonly name: string
	/** The CPUs the sandbox gets. Default: 2. */
	readonly cpus?: number
	/** The sandbox's memory, in MB. Default: 2048. */
	readonly memoryMb?: number
	/**
	 * The package registries a run restores from: public ones, which the package of their ecosystem
	 * defines, such as `nugetOrg` from `@mesh-flow/toolchain-dotnet` and `npmRegistry` from
	 * `@mesh-flow/toolchain-node`, and a connector's own, such as `codeArtifact(...)` from
	 * `@mesh-flow/aws`. Default: none.
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
 * fetch through it is a call to the gateway, which fetches the package on the host, with the
 * connector's credential for a connector's registry. Any other host is refused.
 *
 * ```ts
 * import { npmRegistry } from '@mesh-flow/toolchain-node'
 *
 * export default defineMeshFlow({
 * 	sandbox: image({
 * 		name: 'node:26-slim',
 * 		memoryMb: 4096,
 * 		registries: [npmRegistry],
 * 	}),
 * 	workflows: [
 * 		userTrigger(develop),
 * 	],
 * })
 * ```
 */
export function image(options: ImageOptions): SandboxDescription {
	return Object.freeze({
		image: options.name,
		cpus: options.cpus ?? defaultCpus,
		memoryMb: options.memoryMb ?? defaultMemoryMb,
		registries: Object.freeze(uniqueRegistries(options.registries ?? [])),
	})
}
