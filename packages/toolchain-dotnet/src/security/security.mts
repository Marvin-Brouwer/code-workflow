import { check, type Check, type Finding } from '@mesh-flow/core'
import type { DotnetRepository } from '../directory.mts'
import { listPackages } from '../package-list.mts'

/**
 * A check for `verify`: lists the packages of the checkout, transitive ones too, that have a known
 * vulnerability, with `dotnet list package --vulnerable --include-transitive`, and reports each as
 * a finding with its severity and advisory, once per package and version. The vulnerabilities come
 * from the NuGet sources the checkout restores from.
 *
 * ```ts
 * await developer.loop`Implement ${plan} in ${repository}, then hand in with ${verify(dotnet.security(repository))}.`
 * ```
 */
export function security(repository: DotnetRepository): Check {
	return check('security', async ({ abortSignal }) => {
		const list = await listPackages(repository.directory, ['--vulnerable', '--include-transitive'], abortSignal)
		const packages = list.projects.flatMap((project) =>
			(project.frameworks ?? []).flatMap((framework) => [
				...(framework.topLevelPackages ?? []).map((listed) => ({ kind: 'package', listed })),
				...(framework.transitivePackages ?? []).map((listed) => ({ kind: 'transitive package', listed })),
			]),
		)
		const findings = new Map<string, Finding>()
		for (const { kind, listed } of packages) {
			const version = listed.resolvedVersion ?? listed.requestedVersion ?? ''
			const key = `${listed.id}@${version}`
			const vulnerabilities = listed.vulnerabilities ?? []
			if (findings.has(key) || vulnerabilities.length === 0) continue
			const advisories = vulnerabilities.map(({ severity, advisoryurl }) =>
				advisoryurl === undefined ? severity : `${severity} (${advisoryurl})`,
			)
			findings.set(key, {
				source: 'vulnerable packages',
				message: `${kind} ${listed.id} ${version} has known vulnerabilities: ${advisories.join(', ')}`,
			})
		}
		// A source without vulnerability data, or one that couldn't be reached, is a problem of the
		// list: without this, nothing found would read as nothing vulnerable.
		const problems = (list.problems ?? []).map((problem) => ({ source: 'package audit', message: problem.text }))
		return [...problems, ...findings.values()]
	})
}
