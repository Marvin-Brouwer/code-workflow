import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
	Command,
	ExecOptions,
	ExecResult,
	HeldSandbox,
	PausedSandbox,
	Sandbox,
	SandboxBackend,
	StartInBackgroundOptions,
} from '@mesh-flow/sandbox'
import { SandboxSpec } from '@mesh-flow/sandbox'
import { z } from 'zod'

const HostSandboxState = z.object({
	state: z.enum(['running', 'paused']),
	pids: z.array(z.int()),
	spec: SandboxSpec,
})
type HostSandboxState = z.infer<typeof HostSandboxState>

/** Paths in a host sandbox start with this; each sandbox maps it to a directory of its own. */
export const hostSandboxRoot = '/sandbox/'

/** The layout to give an engine that runs on {@link hostBackend}. */
export const hostSandboxLayout = { mailbox: '/sandbox/mailbox', app: '/sandbox/app' }

/**
 * A stand-in backend for tests: a "sandbox" is a directory on this machine, its commands run on
 * the host, and a pause stops its background processes with `SIGSTOP`. Its state lives on disk,
 * so a second instance (after a crash) can list and remove what the first left behind.
 *
 * Every `/sandbox/` in a path, argument or environment value points into the sandbox's own
 * directory, so two sandboxes don't share files.
 *
 * It calls itself `gvisor`, because `BackendName` only has the real backends.
 */
export function hostBackend(root: string): SandboxBackend & { readonly root: string } {
	const running = new Set<string>()
	let closed = false

	const stateFile = (id: string) => path.join(root, id, 'state.json')
	const readState = async (id: string): Promise<HostSandboxState> =>
		HostSandboxState.parse(JSON.parse(await readFile(stateFile(id), 'utf8')))
	const writeState = (id: string, state: HostSandboxState) => writeFile(stateFile(id), JSON.stringify(state))

	const remove = async (id: string): Promise<void> => {
		if (existsSync(stateFile(id))) {
			for (const pid of (await readState(id)).pids) signalGroup(pid, 'SIGKILL')
		}
		await rm(path.join(root, id), { recursive: true, force: true })
		running.delete(id)
	}

	const open = (id: string): Sandbox => {
		running.add(id)
		const files = path.join(root, id, 'files')
		const map = (value: string) => value.replaceAll(hostSandboxRoot, `${files}/`)
		const mapOptions = (options: ExecOptions): ExecOptions => ({
			signal: options.signal,
			...(options.cwd === undefined ? {} : { cwd: map(options.cwd) }),
			env: Object.fromEntries(Object.entries(options.env ?? {}).map(([key, value]) => [key, map(value)])),
		})
		return {
			id,
			exec: (command, options) => execOnHost([map(command[0]), ...command.slice(1).map(map)], mapOptions(options)),
			async startInBackground(command: Command, options: StartInBackgroundOptions) {
				options.signal.throwIfAborted()
				const mapped = mapOptions(options)
				const log = openSync(map(options.logFile ?? '/dev/null'), 'a')
				const [program, ...args] = command.map(map)
				const child = spawn(program ?? 'false', args, {
					cwd: mapped.cwd,
					env: { ...process.env, ...mapped.env },
					detached: true,
					stdio: ['ignore', log, log],
				})
				closeSync(log)
				child.unref()
				await new Promise<void>((resolve, reject) => {
					child.once('spawn', resolve)
					child.once('error', reject)
				})
				if (child.pid === undefined) throw new Error(`Starting ${program} failed.`)
				const state = await readState(id)
				await writeState(id, { ...state, pids: [...state.pids, child.pid] })
			},
			readFile: (file, signal) => readFile(map(file), { encoding: 'utf8', signal }),
			async writeFile(file, content, signal) {
				// Like the real backends: the parent folder has to be there.
				const target = map(file)
				await writeFile(`${target}.tmp`, content, { signal })
				await rename(`${target}.tmp`, target)
			},
			async pause(signal) {
				signal.throwIfAborted()
				const state = await readState(id)
				for (const pid of state.pids) signalGroup(pid, 'SIGSTOP')
				await writeState(id, { ...state, state: 'paused' })
				running.delete(id)
				return { backend: 'gvisor', id, spec: state.spec } satisfies PausedSandbox
			},
			async destroy() {
				await remove(id)
			},
		}
	}

	return {
		name: 'gvisor',
		root,
		async create(spec, signal) {
			signal.throwIfAborted()
			if (closed) throw new Error('This sandbox backend is closed.')
			const id = `mesh-flow-${randomBytes(6).toString('hex')}`
			await mkdir(path.join(root, id, 'files'), { recursive: true })
			await writeState(id, { state: 'running', pids: [], spec })
			return open(id)
		},
		async resume(paused, signal) {
			signal.throwIfAborted()
			const state = await readState(paused.id)
			for (const pid of state.pids) signalGroup(pid, 'SIGCONT')
			await writeState(paused.id, { ...state, state: 'running' })
			return open(paused.id)
		},
		async list(): Promise<HeldSandbox[]> {
			const ids = existsSync(root) ? await readdir(root) : []
			return Promise.all(ids.map(async (id) => ({ id, state: (await readState(id)).state })))
		},
		remove: (id) => remove(id),
		async close() {
			closed = true
			await Promise.all([...running].map((id) => remove(id)))
		},
	}
}

/** Whether a process still runs. A zombie, killed but not reaped by its parent, doesn't. Linux only. */
export function isAlive(pid: number): boolean {
	try {
		const state = readFileSync(`/proc/${String(pid)}/stat`, 'utf8').split(' ')[2]
		return state !== 'Z' && state !== 'X'
	} catch {
		return false
	}
}

/** The pids of a host sandbox's background processes, read from its state on disk. */
export async function pidsOf(root: string, id: string): Promise<readonly number[]> {
	return HostSandboxState.parse(JSON.parse(await readFile(path.join(root, id, 'state.json'), 'utf8'))).pids
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal)
	} catch {
		// Gone already.
	}
}

function execOnHost(command: Command, options: ExecOptions): Promise<ExecResult> {
	const [program, ...args] = command
	return new Promise((resolve, reject) => {
		execFile(
			program,
			args,
			{ cwd: options.cwd, env: { ...process.env, ...options.env }, signal: options.signal },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== 'number') reject(error)
				else resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })
			},
		)
	})
}
