import { z } from 'zod'
import { workingDirectoryOf } from './directory.mts'
import { noBuildServerArguments, outputTail, runDotnet } from './run-dotnet.mts'

const Vulnerability = z.object({ severity: z.string(), advisoryurl: z.string().optional() })

/** A package as `dotnet list package` lists it, with its vulnerabilities when asked for them. */
const ListedPackage = z.object({
	id: z.string(),
	requestedVersion: z.string().optional(),
	resolvedVersion: z.string().optional(),
	vulnerabilities: z.array(Vulnerability).optional(),
})

/** What `dotnet list package --format json` writes: per project, per target framework, the packages. */
const PackageList = z.object({
	problems: z.array(z.object({ level: z.string().optional(), text: z.string() })).optional(),
	projects: z
		.array(
			z.object({
				path: z.string(),
				frameworks: z
					.array(
						z.object({
							framework: z.string(),
							topLevelPackages: z.array(ListedPackage).optional(),
							transitivePackages: z.array(ListedPackage).optional(),
						}),
					)
					.optional(),
			}),
		)
		.default([]),
})
type PackageList = z.infer<typeof PackageList>

/**
 * Restores, then lists the packages of a solution or project with `dotnet list package`, in its
 * JSON form. `options` are the list's own, such as `--vulnerable`. A restore or list that fails
 * throws with the end of its output: what's in the packages can't be told then.
 */
export async function listPackages(target: string, options: readonly string[], abortSignal: AbortSignal): Promise<PackageList> {
	const cwd = workingDirectoryOf(target)
	const restored = await runDotnet(['restore', target, ...noBuildServerArguments], { cwd, abortSignal })
	if (!restored.ok) throw new Error(`dotnet restore failed:\n${outputTail(restored)}`)
	const listed = await runDotnet(['list', target, 'package', ...options, '--format', 'json'], { cwd, abortSignal })
	if (!listed.ok) throw new Error(`dotnet list package failed:\n${outputTail(listed)}`)
	return PackageList.parse(JSON.parse(listed.stdout))
}
