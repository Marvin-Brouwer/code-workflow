import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { diagnosticsIn, type Diagnostic } from '../build/diagnostics.mts'
import { workingDirectoryOf } from '../directory.mts'
import { outputTail, quietBuildArguments, runDotnet } from '../run-dotnet.mts'
import { outcomeOf, type TestOutcome } from './trx.mts'

/** What a test run came to: the counts and failures, or the build errors that kept the tests from running. */
export interface TestResult extends TestOutcome {
	readonly succeeded: boolean
	/** The build's errors: the tests don't run when it fails. */
	readonly buildErrors: readonly Diagnostic[]
	/** The end of the output, for a failure neither a test nor the build explains. */
	readonly output?: string
}

/** What `runTests` takes. */
export interface RunTestsOptions {
	/** The solution or project to test, or the directory it is in. */
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
	const resultsDirectory = await mkdtemp(path.join(tmpdir(), 'mesh-flow-dotnet-results-'))
	try {
		const run = await runDotnet(
			[
				'test',
				target,
				'--logger',
				'trx',
				'--results-directory',
				resultsDirectory,
				...(filter === undefined ? [] : ['--filter', filter]),
				...quietBuildArguments,
			],
			{ cwd: workingDirectoryOf(target), abortSignal },
		)
		const files = (await readdir(resultsDirectory, { recursive: true })).filter((file) => file.endsWith('.trx'))
		const outcome = outcomeOf(await Promise.all(files.map((file) => readFile(path.join(resultsDirectory, file), 'utf8'))))
		// MSBuild's console logger names the project after each of its errors. A line of a test's own
		// output that only looks like one, such as `Expected: error: not found`, names none.
		const buildErrors = diagnosticsIn(run.stdout).filter(
			(diagnostic) => diagnostic.severity === 'error' && diagnostic.project !== undefined,
		)
		const explained = run.ok || outcome.failures.length > 0 || buildErrors.length > 0
		return { ...outcome, succeeded: run.ok, buildErrors, ...(explained ? {} : { output: outputTail(run) }) }
	} finally {
		await removeScratch(resultsDirectory)
	}
}

/** How many more times removing the scratch directory is tried while a test host that is being stopped still holds a file in it. */
const removeRetries = 5

/**
 * Removes the scratch directory of a run. A failure is left at that: a directory left in the temp
 * folder must not take the place of the run's result, or of the reason it was stopped.
 */
async function removeScratch(directory: string): Promise<void> {
	try {
		await rm(directory, { recursive: true, force: true, maxRetries: removeRetries })
	} catch {
		// The temp folder is cleaned up by the system in time.
	}
}
