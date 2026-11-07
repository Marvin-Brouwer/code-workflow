import { check } from '@mesh-flow/core'
import { type Repository } from '@mesh-flow/git'
import { cli } from './cli'

/** Virus scan and dependency audit; every detection and vulnerable package is a finding. */
export function security(repository: Repository) {
	return check('security', async () => {
		const [scan, audit] = await Promise.all([cli.virusScan(repository), cli.auditPackages(repository)])
		return [
			...scan.detections.map((message) => ({ source: 'virus scan', message })),
			...audit.vulnerable.map((message) => ({ source: 'dependency audit', message })),
		]
	})
}
