import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mailboxEnvironmentVariable, mailboxLayout, RuntimeMessage, type RunStart, type WorkflowsDescription } from '@mesh-flow/protocol'

/** How much of the app's output a failure shows. */
const shownOutputLength = 4_000

/** Where in the repository the bundle is described from, so its native dependencies resolve to the installed ones. */
const describeFolder = '.mesh-flow'

/** What `describeBuiltApp` takes. */
export interface DescribeBuiltAppOptions {
	/** The bundle `buildApp` wrote. */
	readonly bundle: string
	/** The app's repository, whose `node_modules` the bundle's native dependencies come from here. */
	readonly directory: string
	readonly abortSignal: AbortSignal
}

/**
 * Runs the built app in describe mode on this machine and returns what it declares. It is your own
 * code, built from your own repository, the same way the engine would start it, but here instead
 * of in a sandbox, so the engine never has to.
 *
 * A copy of the bundle runs from inside the repository, so the native dependencies it leaves out
 * resolve to the ones installed for this machine, not the sandbox's, wherever the build goes.
 */
export async function describeBuiltApp(options: DescribeBuiltAppOptions): Promise<WorkflowsDescription> {
	const { abortSignal } = options
	await mkdir(path.join(options.directory, describeFolder), { recursive: true })
	const copy = await mkdtemp(path.join(options.directory, describeFolder, 'describe-'))
	const scratch = await mkdtemp(path.join(tmpdir(), 'mesh-flow-describe-'))
	try {
		const entry = path.join(copy, path.basename(options.bundle))
		await copyFile(options.bundle, entry)
		const layout = mailboxLayout(scratch)
		await mkdir(layout.inbox, { recursive: true })
		await writeFile(layout.startFile, JSON.stringify({ mode: 'describe' } satisfies RunStart))
		const output = await runToEnd(entry, { ...process.env, [mailboxEnvironmentVariable]: scratch }, abortSignal)
		const lines = await readFile(layout.outbox, 'utf8').catch(() => '')
		for (const line of lines.split('\n')) {
			if (line.trim() === '') continue
			const message = RuntimeMessage.parse(JSON.parse(line))
			if (message.type === 'described') return message.description
			if (message.type === 'failed') throw new Error(`Describing the app failed: ${message.error}`)
		}
		throw new Error(`The app exited without describing itself. Does its entry file export defineMeshFlow?${shown(output)}`)
	} finally {
		await rm(scratch, { recursive: true, force: true })
		await rm(copy, { recursive: true, force: true })
	}
}

/** Runs `node entry` until it exits, and returns what it wrote. Aborting kills it. */
function runToEnd(entry: string, env: NodeJS.ProcessEnv, abortSignal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'], signal: abortSignal })
		let output = ''
		const collect = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-shownOutputLength)
		}
		child.stdout.on('data', collect)
		child.stderr.on('data', collect)
		child.on('error', reject)
		// Not `close`: a process the app started may hold on to its output after the app has exited.
		child.on('exit', () => {
			resolve(output)
		})
	})
}

function shown(output: string): string {
	return output.trim() === '' ? '' : `\n${output.trim()}`
}
