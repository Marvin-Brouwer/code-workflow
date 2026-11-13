import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { tool } from '@mesh-flow/core'
import { z } from 'zod'
import { quietBuildArguments } from '../build/build.mts'
import { diagnosticsIn, type Diagnostic } from '../build/diagnostics.mts'
import { Directory, workingDirectoryOf } from '../directory.mts'
import { outputTail, runDotnet } from '../run-dotnet.mts'
import { countsOf, type TestCounts } from './trx.mts'

/** What a test run came to: the counts and failures, or the build errors that kept the tests from running. */
export interface TestResult extends TestCounts {
	readonly succeeded: boolean
	/** The build's errors: the tests don't run when it fails. */
	readonly buildErrors: readonly Diagnostic[]
	/** The end of the output, for a failure neither a test nor the build explains. */
	readonly output?: string
}

/** What `runTests` takes. */
export interface RunTestsOptions {
	readonly target: string
	/** A `dotnet test --filter` expression, such as `FullyQualifiedName~Login`. */
	readonly filter?: string | undefined
	readonly abortSignal: AbortSignal
}

/**
 * Runs `dotnet test` on a solution or project, with a results file per test project in a scratch
 * directory, and reads the failures from those: the console's form differs per test framework.
 */
export async function runTests({ target, filter, abortSignal }: RunTestsOptions): Promise<TestResult> {
	const results = await mkdtemp(path.join(tmpdir(), 'mesh-flow-dotnet-test-'))
	try {
		const run = await runDotnet(
			[
				'test',
				target,
				'--logger',
				'trx',
				'--results-directory',
				results,
				...(filter === undefined ? [] : ['--filter', filter]),
				...quietBuildArguments,
			],
			{ cwd: workingDirectoryOf(target), abortSignal },
		)
		const files = (await readdir(results, { recursive: true })).filter((file) => file.endsWith('.trx'))
		const counts = countsOf(await Promise.all(files.map((file) => readFile(path.join(results, file), 'utf8'))))
		const buildErrors = diagnosticsIn(run.stdout).filter((diagnostic) => diagnostic.severity === 'error')
		const explained = run.ok || counts.failures.length > 0 || buildErrors.length > 0
		return { ...counts, succeeded: run.ok, buildErrors, ...(explained ? {} : { output: outputTail(run) }) }
	} finally {
		await rm(results, { recursive: true, force: true })
	}
}

/**
 * The tool that runs the tests of the solution or project in a directory with `dotnet test`, for
 * an agent to run them while it works, all of them or those a filter picks. Each failed test comes
 * back with its message and stack trace; when the build fails, its errors come back instead.
 *
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
