import type { ToolContext } from '../tool/tool.mts'

/** Something a check found that the agent has to fix. */
export interface Finding {
	/** Where it comes from, such as `tests` or `code review: src/order.cs`. */
	readonly source: string
	readonly message: string
}

const checkRun: unique symbol = Symbol.for('mesh-flow.check')

/** A lazy check for `verify`: it only runs when the agent hands in. */
export interface Check {
	readonly name: string
	readonly [checkRun]: (context: ToolContext) => Promise<readonly Finding[]>
}

/**
 * Defines a check. `run` returns what it found; no findings means it passes. It may take its time,
 * for example to wait for a pipeline, and it stops when its signal aborts.
 *
 * ```ts
 * export function testsPass(repository: Repository): Check {
 * 	return check('tests', async ({ abortSignal }) => {
 * 		const result = await runTests(repository, abortSignal)
 * 		return result.failures.map((failure) => ({ source: 'tests', message: failure }))
 * 	})
 * }
 * ```
 *
 * A check that throws fails the loop it runs in, like any other error.
 */
export function check(name: string, run: (context: ToolContext) => Promise<readonly Finding[]>): Check {
	return Object.freeze({ name, [checkRun]: run })
}

/** Runs a check. */
export function runCheck(toRun: Check, context: ToolContext): Promise<readonly Finding[]> {
	return toRun[checkRun](context)
}

/** Findings as a list, one line each, for the agent and for errors. */
export function findingLines(findings: readonly Finding[]): string {
	return findings.map((finding) => `- ${finding.source}: ${finding.message}`).join('\n')
}
