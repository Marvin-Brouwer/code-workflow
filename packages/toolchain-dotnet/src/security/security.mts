import { check, type Check } from '@mesh-flow/core'
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
		const findings = new Map<string, { source: string; message: string }>()
		for (const project of list.projects)
			for (const framework of project.frameworks ?? [])
				for (const [kind, packages] of [
					['package', framework.topLevelPackages],
					['transitive package', framework.transitivePackages],
				] as const)
					for (const listed of packages ?? []) {
						const version = listed.resolvedVersion ?? listed.requestedVersion ?? ''
						const key = `${listed.id}@${version}`
						if (findings.has(key) || listed.vulnerabilities === undefined || listed.vulnerabilities.length === 0) continue
						const advisories = listed.vulnerabilities.map(
							(vulnerability) =>
								`${vulnerability.severity}${vulnerability.advisoryurl === undefined ? '' : ` (${vulnerability.advisoryurl})`}`,
						)
						findings.set(key, {
							source: 'vulnerable packages',
							message: `${kind} ${listed.id} ${version} has known vulnerabilities: ${advisories.join(', ')}`,
						})
					}
		return [...findings.values()]
	})
}
