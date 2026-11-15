import { tool } from '@mesh-flow/core'
import { z } from 'zod'
import { Directory, workingDirectoryOf } from '../directory.mts'
import { outputTail, quietBuildArguments, runDotnet } from '../run-dotnet.mts'
import { diagnosticsIn, type Diagnostic } from './diagnostics.mts'

/** What a build came to: whether it succeeded, its errors, and how many warnings it had. */
export interface BuildResult {
	readonly succeeded: boolean
	readonly errors: readonly Diagnostic[]
	readonly warnings: number
	/** The end of the output, for a failure without an error in MSBuild's form, such as a missing SDK. */
	readonly output?: string
}

/**
 * The tool that builds the solution or project in a directory with `dotnet build`, for an agent to
 * see whether its change compiles. The errors come back in MSBuild's terms, one per error, with
 * the file and line.
 *
 * A tool for agents, and a function for code that wants to know whether a checkout compiles before
 * it goes further. Runs in the sandbox, with the SDK of the sandbox's image.
 *
 * Input: `{ directory, configuration? }`. `directory` is the checkout's absolute path, or that of a
 * solution or project in it; `configuration` is `Debug` (the default) or `Release`. The result says
 * whether the build succeeded, lists its errors with file and line, counts its warnings, and holds
 * the end of the output for a failure that isn't one of MSBuild's errors, such as a missing SDK.
 *
 * @example For an agent
 * ```ts
 * await developer.loop`Implement ${plan} in ${repository}. Build with ${dotnet.build} until it passes.`
 * ```
 *
 * @example From code
 * ```ts
 * const { succeeded, errors } = await dotnet.build({ directory: repository.directory, configuration: 'Release' })
 * if (!succeeded) throw new Error(`${repository.name} doesn't build:\n${errors.map((error) => error.message).join('\n')}`)
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
			succeeded: result.succeeded,
			errors,
			warnings: diagnostics.length - errors.length,
			...(result.succeeded || errors.length > 0 ? {} : { output: outputTail(result) }),
		}
	},
})
