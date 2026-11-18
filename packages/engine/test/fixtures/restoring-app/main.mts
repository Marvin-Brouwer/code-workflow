/**
 * An app the real-backend test builds with `@mesh-flow/core`: its one workflow installs a package
 * with npm, in a sandbox that has no network, so the install only works through the runtime's
 * package proxy and the gateway behind it.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { defineMeshFlow, image, userTrigger, workflow } from '@mesh-flow/core'
import { npmRegistry } from '../../support/registries.mts'
import { restoredPackage } from './restored-package.mts'

const run = promisify(execFile)

const restore = workflow('restore', async () => {
	const project = await mkdtemp(path.join(tmpdir(), 'restore-'))
	await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'project', private: true }))
	await run('npm', ['install', '--no-audit', '--no-fund', `${restoredPackage.name}@${restoredPackage.version}`], { cwd: project })
	const installed = path.join(project, 'node_modules', restoredPackage.name, 'package.json')
	const json: unknown = JSON.parse(await readFile(installed, 'utf8'))
	if (typeof json !== 'object' || json === null || !('version' in json) || json.version !== restoredPackage.version)
		throw new Error(`npm installed something else: ${JSON.stringify(json)}`)
})

export default defineMeshFlow({
	sandbox: image({ name: 'node:26-slim', registries: [npmRegistry] }),
	workflows: [userTrigger(restore)],
})
