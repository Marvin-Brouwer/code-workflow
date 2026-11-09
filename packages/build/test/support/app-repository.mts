import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkflowsDescription } from '@mesh-flow/protocol'
import { temporaryDirectory } from './temporary-directory.mts'

const protocol = pathToFileURL(path.join(import.meta.dirname, '../../../protocol/src/_module/protocol.mts')).href

/** What an app repository holds: its files, and the packages in its `node_modules`. */
export interface AppRepositoryOptions {
	/** Files by path relative to the repository. */
	readonly files?: Record<string, string>
	/** Installed packages: their `package.json` and other files. Listed in the app's dependencies. */
	readonly packages?: Record<string, { readonly json?: Record<string, unknown>; readonly files?: Record<string, string> }>
	/** `main` in the app's `package.json`. Default: `main.mts`. */
	readonly main?: string | null
}

/**
 * A stand-in for an entry file made with `defineMeshFlow`, as the build sees it: in describe mode
 * it sends `description`, and it imports `./greeting.mts` and the `greeting` package, so a test
 * sees them bundled.
 */
export function describingEntry(description: WorkflowsDescription): string {
	return `import { RuntimeMailbox } from '${protocol}'
import { punctuation } from 'greeting'
import { greeting } from './greeting.mts'

const mailbox = RuntimeMailbox.fromEnvironment()
const start = await mailbox.readStart(new AbortController().signal)
if (start.mode === 'describe') mailbox.send({ type: 'described', description: ${JSON.stringify(description)} })
console.log(greeting + punctuation)
`
}

/** An app repository with its dependencies installed, removed when the test ends. */
export async function appRepository(options: AppRepositoryOptions = {}): Promise<string> {
	const directory = await temporaryDirectory()
	const packages = options.packages ?? {}
	const dependencies = Object.fromEntries(Object.keys(packages).map((name) => [name, '1.0.0']))
	const main = options.main === undefined ? 'main.mts' : options.main
	await writeFile(
		path.join(directory, 'package.json'),
		JSON.stringify({ type: 'module', ...(main === null ? {} : { main }), dependencies }),
	)
	for (const [file, content] of Object.entries(options.files ?? {})) await writeAt(path.join(directory, file), content)
	for (const [name, { json = {}, files = {} }] of Object.entries(packages)) {
		const folder = path.join(directory, 'node_modules', name)
		await writeAt(path.join(folder, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js', ...json }))
		for (const [file, content] of Object.entries(files)) await writeAt(path.join(folder, file), content)
	}
	return directory
}

async function writeAt(file: string, content: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true })
	await writeFile(file, content)
}
