import path from 'node:path'
import { tool, type ToolContext } from '@mesh-flow/core'
import { z } from 'zod'
import { Directory, workingDirectoryOf } from '../directory.mts'
import { listPackages } from '../package-list.mts'
import { outputTail, runDotnet } from '../run-dotnet.mts'
import { targetOf, type DotnetCheckout, type DotnetTargetOptions } from '../target.mts'

/** A package at a version, such as one an upstream merge published. */
export interface PackageVersion {
	readonly name: string
	readonly version: string
}

/** A package reference that `updatePackages` moved to another version. */
export interface PackageUpdate {
	/** The project, relative to the checkout. */
	readonly project: string
	readonly name: string
	/**
	 * The version the project asked for before, or undefined when it named none, as a reference
	 * without a version does.
	 */
	readonly from?: string
	readonly to: string
}

/** A reference the update tool moved, by the project's full path: `updatePackages` makes it relative to the checkout. */
type UpdatedReference = Omit<PackageUpdate, 'project'> & { readonly projectPath: string }

/** An exact version as NuGet writes it, `[2.4.0]`. A bare `2.4.0` is a minimum, and here both mean that version (see `asksFor`). */
const exactVersion = /^\[([^,\]]+)\]$/

/** Whether a project's reference asks for `version`, written either way. */
function asksFor(requested: string | undefined, version: string): boolean {
	if (requested === undefined) return false
	const trimmed = requested.trim()
	return (exactVersion.exec(trimmed)?.[1] ?? trimmed) === version
}

/** NuGet ignores case in package ids. */
function sameId(one: string, other: string): boolean {
	return one.toLowerCase() === other.toLowerCase()
}

/**
 * The update as a tool, so a run's events show what it was called with. A rerun changes nothing
 * since a reference at the version is left alone.
 */
const updateTool = tool('dotnetUpdatePackages', {
	description: 'Moves the package references of the .NET projects in a directory to the versions given',
	input: z.object({
		directory: Directory,
		packages: z.array(z.object({ name: z.string().min(1), version: z.string().min(1) })),
	}),
	action: async ({ directory, packages }, { abortSignal }): Promise<readonly UpdatedReference[]> => {
		if (packages.length === 0) return []
		const workingDirectory = workingDirectoryOf(directory)
		const list = await listPackages(directory, [], abortSignal)
		const updates: UpdatedReference[] = []
		for (const project of list.projects) {
			const referenced = (project.frameworks ?? []).flatMap((framework) => framework.topLevelPackages ?? [])
			for (const wanted of packages) {
				const current = referenced.find((listed) => sameId(listed.id, wanted.name))
				if (current === undefined || asksFor(current.requestedVersion, wanted.version)) continue
				// One at a time: `dotnet add` writes the project file, or Directory.Packages.props under central package management.
				const added = await runDotnet(['add', project.path, 'package', current.id, '--version', wanted.version], {
					workingDirectory,
					abortSignal,
				})
				if (!added.succeeded) throw new Error(`dotnet add package ${current.id} ${wanted.version} failed:\n${outputTail(added)}`)
				updates.push({
					projectPath: project.path,
					name: current.id,
					...(current.requestedVersion === undefined ? {} : { from: current.requestedVersion }),
					to: wanted.version,
				})
			}
		}
		return updates
	},
})

/**
 * Moves the package references of the checkout's projects to the versions given, such as the
 * packages an upstream merge request published, with `dotnet add package`: under central package
 * management, that writes `Directory.Packages.props`. Only packages a project references directly
 * are updated; one already at the version is left as it is, so a rerun changes nothing. No
 * packages, no work. Resolves to what was updated. `options.target` names the solution or project
 * when the checkout has none at its root, or more than one.
 *
 * Runs in the sandbox, with the SDK of the sandbox's image; the packages come from the NuGet
 * sources the checkout restores from.
 *
 * @param repository - The checkout to update: anything with a `directory`, such as a connector's
 * checkout.
 * @param packages - The packages and the versions to move to, such as
 * `gitlab.publishedPackages` gives. Package ids are compared without regard to case, as NuGet does.
 * @param options - `target`: the solution or project, relative to the checkout.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns Each reference that was moved: the project, relative to the checkout, the package, and
 * the version before and after.
 * @throws When the restore or the list of packages fails, as for a source that can't be reached;
 * when `dotnet add package` fails, such as for a version no source has; and, with the stop's
 * reason, when the run stops.
 *
 * @example After an upstream merge
 * ```ts
 * await dotnet.updatePackages(repository, upstream)
 * ```
 *
 * @example A version of your own
 * ```ts
 * const updates = await dotnet.updatePackages(repository, [{ name: 'Serilog', version: '4.3.0' }])
 * if (updates.length > 0) await gitlab.push(repository)({ message: 'Update Serilog to 4.3.0' })
 * ```
 */
export async function updatePackages(
	repository: DotnetCheckout,
	packages: readonly PackageVersion[],
	options: DotnetTargetOptions = {},
	context?: ToolContext,
): Promise<readonly PackageUpdate[]> {
	const updates = await updateTool({ directory: targetOf(repository, options), packages: [...packages] }, context)
	return updates.map(({ projectPath, ...update }) => ({ ...update, project: path.relative(repository.directory, projectPath) }))
}
