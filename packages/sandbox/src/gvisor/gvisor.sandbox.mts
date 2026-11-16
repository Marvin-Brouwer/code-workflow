import { randomUUID } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { PausedSandbox } from '../paused-sandbox.mts'
import type { Command, ExecOptions, ExecResult, Sandbox, StartInBackgroundOptions } from '../sandbox.mts'
import type { SandboxSpec } from '../sandbox-spec.mts'
import { newCheckpointName, partialCheckpoint, removeEarlierCheckpoints } from './checkpoint.mts'
import type { GvisorContext } from './gvisor.context.mts'
import { jobDirectory, jobScript, submitJobCommand } from './init.mts'
import { runsc, runscOrThrow } from './runsc.mts'

/** A running gVisor container. Its runsc container id is the sandbox id. */
export class GvisorSandbox implements Sandbox {
	readonly id: string
	readonly #spec: SandboxSpec
	readonly #context: GvisorContext

	constructor(id: string, spec: SandboxSpec, context: GvisorContext) {
		this.id = id
		this.#spec = spec
		this.#context = context
		context.lifetime.track(id, (signal) => context.remove(id, signal))
	}

	async exec(command: Command, options: ExecOptions): Promise<ExecResult> {
		const flags = Object.entries(options.env ?? {}).map(([key, value]) => `--env=${key}=${value}`)
		if (options.cwd !== undefined) flags.push(`--cwd=${options.cwd}`)
		return runsc(this.#context.runsc, ['exec', ...flags, this.id, ...command], {
			signal: this.#context.lifetime.bind(options.signal),
		})
	}

	/** Hands the command to the sandbox's init (`initCommand`): exec'd processes don't survive a pause. */
	async startInBackground(command: Command, options: StartInBackgroundOptions): Promise<void> {
		const job = `${jobDirectory}/job-${randomUUID()}.sh`
		await this.writeFile(job, jobScript(command, options), options.signal)
		const result = await this.exec(submitJobCommand(job, options), { signal: options.signal })
		if (result.exitCode !== 0) {
			throw new Error(`Starting ${command[0]} failed with exit code ${String(result.exitCode)}: ${result.stderr.trim()}`)
		}
	}

	async readFile(path: string, signal: AbortSignal): Promise<string> {
		const result = await this.exec(['cat', '--', path], { signal })
		if (result.exitCode !== 0) throw new Error(`Reading ${path} failed: ${result.stderr.trim()}`)
		return result.stdout
	}

	async writeFile(path: string, content: string, signal: AbortSignal): Promise<void> {
		const script = 'cat > "$1.tmp" && mv -- "$1.tmp" "$1"'
		await runscOrThrow(this.#context.runsc, ['exec', this.id, 'sh', '-c', script, 'sh', path], {
			signal: this.#context.lifetime.bind(signal),
			input: content,
		})
	}

	/**
	 * `runsc checkpoint` writes memory, processes and the in-memory filesystem to disk and ends the
	 * sandbox. It takes as long as writing the sandbox's memory takes: under a second on a fast
	 * disk, seconds on a slow one.
	 */
	async pause(signal: AbortSignal): Promise<PausedSandbox> {
		const bound = this.#context.lifetime.bind(signal)
		const { checkpoints } = this.#context.layout.sandbox(this.id)
		const name = newCheckpointName()
		const partial = partialCheckpoint(checkpoints, name)
		await mkdir(partial, { recursive: true })
		await runscOrThrow(this.#context.runsc, ['checkpoint', `--image-path=${partial}`, this.id], { signal: bound })
		await rename(partial, join(checkpoints, name))
		this.#context.lifetime.untrack(this.id)
		// Housekeeping from here on: a failure may not lose the pause that just worked. Resume
		// deletes a leftover container record itself.
		await runsc(this.#context.runsc, ['delete', '--force', this.id], { signal: bound }).catch(() => undefined)
		await this.#context.proxies.stop(this.id, bound).catch(() => undefined)
		await removeEarlierCheckpoints(checkpoints, name).catch(() => undefined)
		return { backend: 'gvisor', id: this.id, spec: this.#spec, snapshot: name }
	}

	destroy(signal: AbortSignal): Promise<void> {
		return this.#context.lifetime.destroy(this.id, signal)
	}
}
