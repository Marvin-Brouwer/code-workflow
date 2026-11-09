import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { temporaryDirectory } from './temporary-directory.mts'

const sources = path.join(import.meta.dirname, '../../../protocol/src')

/** The files the runtime's mailbox needs from `@mesh-flow/protocol`. Its other imports are types only. */
const mailboxFiles = ['runtime-mailbox.mts', 'mailbox-layout.mts']

/** Imports the mailbox from this package's sources, for runtimes that run on the host. */
export const hostMailbox = pathToFileURL(path.join(sources, 'runtime-mailbox.mts')).href

/** Imports the mailbox from the copy {@link workflowRepository} makes for a real sandbox. */
export const copiedMailbox = '../mesh-flow/runtime-mailbox.mts'

/**
 * A runtime for tests: the body runs with `mailbox`, `signal` and `event(id, type, fields)` in
 * scope, as the real runtime from `@mesh-flow/core` will.
 */
export function runtimeScript(body: string, mailboxModule = hostMailbox): string {
	return `import { RuntimeMailbox } from '${mailboxModule}'
const mailbox = RuntimeMailbox.fromEnvironment()
const signal = new AbortController().signal
const event = (id, type, fields = {}) => mailbox.send({ type: 'event', event: { id, type, at: new Date().toISOString(), ...fields } })
${body}
`
}

export interface WorkflowRepositoryOptions {
	readonly setup?: string[][]
	/** The sandbox image. Default `host`, for the host backend. */
	readonly image?: string
	/** Copies the mailbox's sources into the repository, for a real sandbox. */
	readonly copyMailbox?: boolean
}

/**
 * The entry file {@link workflowRepository} writes when the test gives none: it runs the workflow's
 * own file, `workflows/<name>.mts`, so each test workflow is a runtime script of its own.
 */
const dispatchingEntry = `import { readFileSync } from 'node:fs'
const start = JSON.parse(readFileSync(process.env.MESH_FLOW_MAILBOX + '/start.json', 'utf8'))
await import('./workflows/' + start.workflow + '.mts')
`

/**
 * A workflow repository in git, with a config that runs the entry file with `node`. Each workflow
 * is a file of its own, which the entry file runs; a workflow called `main` is the entry file, `main.mts`.
 */
export async function workflowRepository(workflows: Record<string, string>, options: WorkflowRepositoryOptions = {}): Promise<string> {
	const directory = await temporaryDirectory()
	const config = {
		sandbox: { image: options.image ?? 'host', cpus: 1, memoryMb: 512, egress: { allow: [] } },
		setup: options.setup ?? [],
		start: ['node'],
	}
	await writeFile(path.join(directory, 'mesh-flow.config.json'), JSON.stringify(config, null, '\t'))
	await mkdir(path.join(directory, 'workflows'))
	for (const [name, script] of Object.entries({ main: dispatchingEntry, ...workflows })) {
		// The entry file sits next to the config; the workflows it runs in their own folder.
		await writeFile(name === 'main' ? path.join(directory, 'main.mts') : path.join(directory, 'workflows', `${name}.mts`), script)
	}
	if (options.copyMailbox) {
		for (const file of mailboxFiles) {
			await mkdir(path.dirname(path.join(directory, 'mesh-flow', file)), { recursive: true })
			await copyFile(path.join(sources, file), path.join(directory, 'mesh-flow', file))
		}
	}
	const git = (...args: string[]) =>
		execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: directory })
	git('init', '--quiet')
	git('add', '.')
	git('commit', '--quiet', '-m', 'workflows')
	return directory
}
