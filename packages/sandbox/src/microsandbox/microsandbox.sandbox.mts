import { Snapshot, type Sandbox as MicrosandboxSdkSandbox } from 'microsandbox'
import { abortable } from '../abortable.mts'
import type { BackendLifetime } from '../backend-lifetime.mts'
import type { PausedSandbox } from '../paused-sandbox.mts'
import type { Command, ExecOptions, ExecResult, Sandbox, StartInBackgroundOptions } from '../sandbox.mts'
import type { SandboxSpec } from '../sandbox-spec.mts'
import { startInOwnSession } from '../start-in-background.mts'
import { snapshotName, snapshotsOf } from './snapshots.mts'
import { removeSandbox, removeSandboxAndSnapshots, removeSnapshot } from './vms.mts'

/**
 * A running microVM. Its microsandbox name is the sandbox id.
 *
 * The SDK takes no abort signals: calls are raced against the signal, and a command that is
 * still running when the signal aborts is killed.
 */
export class MicrosandboxSandbox implements Sandbox {
	readonly #sandbox: MicrosandboxSdkSandbox
	readonly #spec: SandboxSpec
	readonly #lifetime: BackendLifetime

	constructor(sandbox: MicrosandboxSdkSandbox, spec: SandboxSpec, lifetime: BackendLifetime) {
		this.#sandbox = sandbox
		this.#spec = spec
		this.#lifetime = lifetime
		lifetime.track(this.id, (signal) => abortable(lifetime.keep(removeSandboxAndSnapshots(sandbox.name)), signal))
	}

	get id(): string {
		return this.#sandbox.name
	}

	async exec(command: Command, options: ExecOptions): Promise<ExecResult> {
		const signal = this.#lifetime.bind(options.signal)
		const [program, ...args] = command
		const handle = await abortable(
			this.#sandbox.execStreamWith(program, (builder) => {
				const withArgs = builder.args(args).envs({ ...options.env })
				return options.cwd === undefined ? withArgs : withArgs.cwd(options.cwd)
			}),
			signal,
			(late) => late.kill(),
		)
		const kill = () => {
			handle.kill().catch(() => undefined)
		}
		signal.addEventListener('abort', kill, { once: true })
		// The signal may have aborted while the command was starting, before there was a listener.
		if (signal.aborted) kill()
		try {
			const output = await abortable(handle.collect(), signal)
			return { exitCode: output.code, stdout: output.stdout(), stderr: output.stderr() }
		} finally {
			signal.removeEventListener('abort', kill)
		}
	}

	startInBackground(command: Command, options: StartInBackgroundOptions): Promise<void> {
		return startInOwnSession(this, command, options)
	}

	readFile(path: string, signal: AbortSignal): Promise<string> {
		return abortable(this.#sandbox.fs().readToString(path), this.#lifetime.bind(signal))
	}

	async writeFile(path: string, content: string, signal: AbortSignal): Promise<void> {
		const bound = this.#lifetime.bind(signal)
		await abortable(this.#sandbox.fs().write(`${path}.tmp`, content), bound)
		await abortable(this.#sandbox.fs().rename(`${path}.tmp`, path), bound)
	}

	/**
	 * A full snapshot (disk, memory and processes), then the VM is killed and removed. microsandbox
	 * refuses a full snapshot while it manages a running job, see `startInOwnSession`.
	 */
	async pause(signal: AbortSignal): Promise<PausedSandbox> {
		const bound = this.#lifetime.bind(signal)
		const name = snapshotName(this.id)
		const snapshot = await abortable(Snapshot.builder(name).fromSandbox(this.id).full().create(), bound)
		await abortable(removeSandbox(this.#sandbox), bound)
		this.#lifetime.untrack(this.id)
		// Housekeeping only: neither a failure nor an abort here may lose the pause that just worked.
		await abortable(removeEarlierSnapshots(this.id, name), bound).catch(() => undefined)
		return { backend: 'microsandbox', id: this.id, spec: this.#spec, snapshot: snapshot.reference }
	}

	destroy(signal: AbortSignal): Promise<void> {
		return this.#lifetime.destroy(this.id, signal)
	}
}

/**
 * Earlier pauses of the same sandbox. microsandbox refuses to remove a snapshot another one
 * depends on, and that refusal is fine: it stays until the sandbox is removed. The new one is
 * known by the name it was given: a listed reference isn't guaranteed to be spelled like the one
 * `create()` returns (Windows paths), and comparing those removed the new snapshot there.
 */
async function removeEarlierSnapshots(id: string, keep: string): Promise<void> {
	for (const snapshot of await snapshotsOf(id)) {
		if (snapshot.name === keep) continue
		await removeSnapshot(snapshot).catch(() => undefined)
	}
}
