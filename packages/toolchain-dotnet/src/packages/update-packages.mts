import path from 'node:path'
import { tool, type ToolContext } from '@mesh-flow/core'
import { z } from 'zod'
import { Directory, targetOf, workingDirectoryOf, type DotnetRepository, type DotnetTargetOptions } from '../directory.mts'
import { listPackages } from '../package-list.mts'
import { outputTail, runDotnet } from '../run-dotnet.mts'

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
	// The projects by their full paths: `updatePackages` makes them relative to the checkout.
	action: async ({ directory, packages }, { abortSignal }): Promise<readonly PackageUpdate[]> => {
		if (packages.length === 0) return []
		const cwd = workingDirectoryOf(directory)
		const list = await listPackages(directory, [], abortSignal)
		const updates: PackageUpdate[] = []
		for (const project of list.projects) {
			const referenced = (project.frameworks ?? []).flatMap((framework) => framework.topLevelPackages ?? [])
			for (const wanted of packages) {
				const current = referenced.find((listed) => sameId(listed.id, wanted.name))
				if (current === undefined || asksFor(current.requestedVersion, wanted.version)) continue
				// One at a time: `dotnet add` writes the project file, or Directory.Packages.props under central package management.
				const added = await runDotnet(['add', project.path, 'package', current.id, '--version', wanted.version], { cwd, abortSignal })
				if (!added.ok) throw new Error(`dotnet add package ${current.id} ${wanted.version} failed:\n${outputTail(added)}`)
				updates.push({
					project: project.path,
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
 * ```ts
 * await dotnet.updatePackages(repository, upstream.flatMap((dependency) => dependency.packages))
 * ```
 */
export async function updatePackages(
	repository: DotnetRepository,
	packages: readonly PackageVersion[],
	options: DotnetTargetOptions = {},
	context?: ToolContext,
): Promise<readonly PackageUpdate[]> {
	const updates = await updateTool({ directory: targetOf(repository, options), packages: [...packages] }, context)
	return updates.map((update) => ({ ...update, project: path.relative(repository.directory, update.project) }))
}
