import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
	type AppManifest,
	appManifestFile,
	mailboxEnvironmentVariable,
	mailboxLayout,
	type TriggerDescription,
	type WorkflowDescription,
} from '@mesh-flow/protocol'
import type { AppStore, AppVersion } from '../../src/apps/app-store.mts'
import { withPackedApp } from '../../src/cli/with-packed-app.mts'
import type { ControlClient, DeployedApp } from '../../src/control/control-client.mts'
import { temporaryDirectory } from './temporary-directory.mts'

const sources = path.join(import.meta.dirname, '../../../protocol/src')

/** The files the runtime's mailbox needs from `@mesh-flow/protocol`. Its other imports are types only. */
const mailboxFiles = ['runtime-mailbox.mts', 'mailbox-layout.mts']

/** Imports the mailbox from this package's sources, for runtimes that run on the host. */
export const hostMailbox = pathToFileURL(path.join(sources, 'runtime-mailbox.mts')).href

/** Imports the mailbox from the copy {@link builtApp} makes for a real sandbox. */
export const copiedMailbox = '../mesh-flow/runtime-mailbox.mts'

/** How long a test gives a deploy. */
const deployTimeoutMs = 10_000

function deploySignal(): AbortSignal {
	return AbortSignal.timeout(deployTimeoutMs)
}

/** The app tests deploy, unless they name another. */
export const testAppName = 'team'

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

/** How {@link builtApp} lays out a test app. */
export interface TestAppOptions {
	/** The sandbox image. Default `host`, for the host backend. */
	readonly image?: string
	/** Copies the mailbox's sources into the app, for a real sandbox. */
	readonly copyMailbox?: boolean
	/** The workflows the app declares. Default: each workflow file, taking any object. */
	readonly workflows?: readonly WorkflowDescription[]
	/** The triggers the app lists. Default: a user trigger for each workflow file. */
	readonly triggers?: readonly TriggerDescription[]
	/** The host tools the app calls through the gateway. Default: none. */
	readonly tools?: readonly string[]
	/** The models the app's agents use. Default: none. */
	readonly models?: readonly string[]
}

/**
 * The entry file {@link builtApp} writes when the test gives none: it runs the workflow's own file,
 * `workflows/<name>.mts`, so each test workflow is a runtime script of its own.
 */
const dispatchingEntry = `import { readFileSync } from 'node:fs'
const startFile = process.env[${JSON.stringify(mailboxEnvironmentVariable)}] + '/${path.posix.basename(mailboxLayout('/').startFile)}'
const start = JSON.parse(readFileSync(startFile, 'utf8'))
await import('./workflows/' + start.workflow + '.mts')
`

/** The entry file of every test app. */
const entry = 'main.mts'

/**
 * A folder laid out like what `mesh-flow build` writes: an entry file, the workflows it runs, and a
 * manifest. Each workflow is a file of its own; a workflow called `main` is the entry file itself.
 */
export async function builtApp(workflows: Record<string, string>, options: TestAppOptions = {}): Promise<string> {
	const directory = await temporaryDirectory()
	const names = Object.keys(workflows).filter((name) => name !== 'main')
	const manifest: AppManifest = {
		entry,
		platform: { os: 'linux', cpu: 'x64' },
		description: {
			sandbox: { image: options.image ?? 'host', cpus: 1, memoryMb: 512, egress: { allow: [] } },
			workflows: options.workflows ? [...options.workflows] : names.map((name) => ({ name, parameters: { type: 'object' } })),
			triggers: options.triggers ? [...options.triggers] : names.map((name) => ({ kind: 'user', id: name, workflow: name })),
			tools: [...(options.tools ?? [])],
			models: [...(options.models ?? [])],
		},
		builtAt: new Date().toISOString(),
	}
	await writeFile(path.join(directory, appManifestFile), JSON.stringify(manifest, null, '\t'))
	await mkdir(path.join(directory, 'workflows'))
	for (const [name, script] of Object.entries({ main: dispatchingEntry, ...workflows })) {
		await writeFile(name === 'main' ? path.join(directory, entry) : path.join(directory, 'workflows', `${name}.mts`), script)
	}
	if (options.copyMailbox) {
		await mkdir(path.join(directory, 'mesh-flow'))
		for (const file of mailboxFiles) await copyFile(path.join(sources, file), path.join(directory, 'mesh-flow', file))
	}
	return directory
}

/** Builds a test app with {@link builtApp} and deploys it to `apps` as `name`. */
export async function deployTestApp(
	apps: AppStore,
	workflows: Record<string, string>,
	options: TestAppOptions & { readonly name?: string } = {},
): Promise<AppVersion> {
	const folder = await builtApp(workflows, options)
	return withPackedApp(folder, (tarball) => apps.deploy(options.name ?? testAppName, tarball, deploySignal()), deploySignal())
}

/** Starts `workflow` of the test app through its user trigger. */
export function userRun(workflow: string, input?: unknown) {
	return { app: testAppName, trigger: { kind: 'user' as const, id: workflow }, ...(input === undefined ? {} : { input }) }
}

/** Builds a test app with {@link builtApp} and deploys it through the control API, as `mesh-flow deploy` does. */
export async function deployThroughApi(
	client: ControlClient,
	workflows: Record<string, string>,
	options: TestAppOptions = {},
): Promise<DeployedApp> {
	const folder = await builtApp(workflows, options)
	return withPackedApp(folder, (tarball) => client.deploy(testAppName, tarball, deploySignal()), deploySignal())
}
