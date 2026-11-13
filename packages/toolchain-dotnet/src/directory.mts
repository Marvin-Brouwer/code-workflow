import path from 'node:path'
import { z } from 'zod'

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

/** A directory an agent names, as checkouts render in prompts: an absolute path. */
export const Directory = z
	.string()
	.refine((directory) => path.isAbsolute(directory), 'Use the absolute path of the checkout, as the prompt shows it.')
	.describe('The absolute path of the checkout, or of a project or solution in it')

/** A solution or project file, which `dotnet` takes in place of a directory. */
const projectFile = /\.(sln|slnx|slnf|csproj|fsproj|vbproj|proj)$/i

/** Where `dotnet` runs for a target: the directory itself, or the one a solution or project file is in. */
export function workingDirectoryOf(target: string): string {
	return projectFile.test(target) ? path.dirname(target) : target
}
