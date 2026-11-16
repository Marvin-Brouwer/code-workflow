import path from 'node:path'

/** What the toolchain works on: a checkout, such as a connector's, by where it is on disk. */
export interface DotnetCheckout {
	/** The checkout on disk. */
	readonly directory: string
}

/** What the checks and `updatePackages` take besides the checkout. */
export interface DotnetTargetOptions {
	/**
	 * The solution or project to work on, relative to the checkout. Default: the checkout itself,
	 * where `dotnet` takes the one solution or project at its root; it doesn't look further down,
	 * and fails when there are more, such as an `.sln` beside its `.slnx`.
	 */
	readonly target?: string | undefined
}

/** What `dotnet` works on for a checkout: the solution or project `options` name, or the checkout. */
export function targetOf(repository: DotnetCheckout, options: DotnetTargetOptions): string {
	return options.target === undefined ? repository.directory : path.resolve(repository.directory, options.target)
}
