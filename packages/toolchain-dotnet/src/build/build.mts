import { tool } from '@mesh-flow/core'
import { z } from 'zod'
import { Directory, workingDirectoryOf } from '../directory.mts'
import { outputTail, runDotnet } from '../run-dotnet.mts'
import { diagnosticsIn, type Diagnostic } from './diagnostics.mts'

/** What a build came to: whether it succeeded, its errors, and how many warnings it had. */
export interface BuildResult {
	readonly succeeded: boolean
	readonly errors: readonly Diagnostic[]
	readonly warnings: number
	/** The end of the output, for a failure without an error in MSBuild's form, such as a missing SDK. */
	readonly output?: string
}

/** The arguments that keep MSBuild's output to what matters, and no build servers behind. */
export const quietBuildArguments = ['-nologo', '-clp:NoSummary', '--disable-build-servers']

/**
 * The tool that builds the solution or project in a directory with `dotnet build`, for an agent to
 * see whether its change compiles. The errors come back in MSBuild's terms, one per error, with
 * the file and line.
 *
 * ```ts
 * await developer.loop`Implement ${plan} in ${repository}. Build with ${dotnet.build} until it passes.`
 * ```
 */
export const build = tool('dotnetBuild', {
	description: 'Builds the .NET solution or project in a directory with `dotnet build`, and lists its errors',
	input: z.object({
		directory: Directory,
		configuration: z.enum(['Debug', 'Release']).default('Debug').describe('The build configuration'),
	}),
	action: async ({ directory, configuration }, { abortSignal }): Promise<BuildResult> => {
		const result = await runDotnet(['build', directory, '--configuration', configuration, ...quietBuildArguments], {
			cwd: workingDirectoryOf(directory),
			abortSignal,
		})
		const diagnostics = diagnosticsIn(result.stdout)
		const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
		return {
			succeeded: result.ok,
			errors,
			warnings: diagnostics.length - errors.length,
			...(result.ok || errors.length > 0 ? {} : { output: outputTail(result) }),
		}
	},
})
