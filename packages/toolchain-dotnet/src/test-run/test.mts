import { tool } from '@mesh-flow/core'
import { z } from 'zod'
import { Directory } from '../directory.mts'
import { runTests } from './run-tests.mts'

/**
 * The tool that runs the tests of the solution or project in a directory with `dotnet test`, for
 * an agent to run them while it works, all of them or those a filter picks. Each failed test comes
 * back with its message and stack trace; when the build fails, its errors come back instead.
 *
 * A tool for agents and a function for code. Runs in the sandbox's image, with its SDK.
 *
 * Input: `{ directory, filter? }`. `directory` is the checkout's absolute path, or that of a
 * solution or project in it; `filter` is a `dotnet test --filter` expression, such as
 * `FullyQualifiedName~Login`. The result says whether the run succeeded, and lists the failed
 * tests, or the build's errors when the tests didn't get to run.
 *
 * @throws When `directory` isn't an absolute path, when `dotnet` can't run, such as when it isn't
 * installed, and when it writes more output than is kept.
 *
 * @example From code
 * ```ts
 * const result = await dotnet.test({ directory: repository.directory, filter: 'Category=Smoke' })
 * const failed = [...result.failures.map((failure) => failure.name), ...result.buildErrors.map((error) => error.message)]
 * if (!result.succeeded) await jira.comment(story, `The smoke tests of ${repository.name} fail: ${failed.join(', ')}`)
 * ```
 *
 * @example For an agent
 * ```ts
 * await developer.loop`Implement ${plan} in ${repository}. Test with ${dotnet.test} until the tests pass.`
 * ```
 */
export const test = tool('dotnetTest', {
	description: 'Runs the tests of the .NET solution or project in a directory with `dotnet test`, and lists the failures',
	input: z.object({
		directory: Directory,
		filter: z.string().min(1).optional().describe('A `dotnet test --filter` expression, such as FullyQualifiedName~Login'),
	}),
	action: ({ directory, filter }, { abortSignal }) => runTests({ target: directory, filter, abortSignal }),
})
