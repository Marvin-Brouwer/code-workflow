import { check, type Check } from '@mesh-flow/core'
import { diagnosticLine } from '../build/diagnostics.mts'
import { targetOf, type DotnetCheckout, type DotnetTargetOptions } from '../target.mts'
import { runTests } from './run-tests.mts'

/**
 * A check for `verify`: runs every test of the checkout with `dotnet test`, and reports each build
 * error and each failed test as a finding. A run that fails for another reason is a finding with
 * the end of its output.
 * `options.target` names the solution or project when the checkout has none at its root, or more
 * than one.
 *
 * ```ts
 * await developer.loop`Implement ${plan} in ${repository}, then hand in with ${verify(dotnet.testsPass(repository))}.`
 * ```
 */
export function testsPass(repository: DotnetCheckout, options: DotnetTargetOptions = {}): Check {
	return check('tests', async ({ abortSignal }) => {
		const result = await runTests({ target: targetOf(repository, options), abortSignal })
		const failures = result.failures.map((failure) => ({
			source: `test: ${failure.name}`,
			message: failure.stackTrace === undefined ? failure.message : `${failure.message}\n${failure.stackTrace}`,
		}))
		const buildErrors = result.buildErrors.map((error) => ({ source: 'build', message: diagnosticLine(error) }))
		if (failures.length > 0 || buildErrors.length > 0 || result.succeeded) return [...buildErrors, ...failures]
		return [{ source: 'tests', message: `dotnet test failed:\n${result.output ?? ''}` }]
	})
}
