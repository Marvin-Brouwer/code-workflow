import { CommandExitError, type Sandbox as E2bSdkSandbox } from 'e2b'
import { quote } from 'shell-quote'
import type { BackendLifetime } from '../backend-lifetime.mts'
import type { PausedSandbox } from '../paused-sandbox.mts'
import type { Command, ExecOptions, ExecResult, Sandbox, StartInBackgroundOptions } from '../sandbox.mts'
import type { SandboxSpec } from '../sandbox-spec.mts'
import { startInOwnSession } from '../start-in-background.mts'

/** A running E2B sandbox. Its id is E2B's own sandbox id. */
export class E2bSandbox implements Sandbox {
	readonly #sandbox: E2bSdkSandbox
	readonly #spec: SandboxSpec
	readonly #lifetime: BackendLifetime

	constructor(sandbox: E2bSdkSandbox, spec: SandboxSpec, lifetime: BackendLifetime) {
		this.#sandbox = sandbox
		this.#spec = spec
		this.#lifetime = lifetime
		lifetime.track(this.id, async (signal) => {
			await sandbox.kill({ signal })
		})
	}

	get id(): string {
		return this.#sandbox.sandboxId
	}

	async exec(command: Command, options: ExecOptions): Promise<ExecResult> {
		const signal = this.#lifetime.bind(options.signal)
		try {
			// E2B runs a command line through a shell, so the arguments are quoted for it.
			const result = await this.#sandbox.commands.run(quote(command), {
				envs: { ...options.env },
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				// No time limit of its own: the signal decides how long a command may take.
				timeoutMs: 0,
				signal,
			})
			return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
		} catch (error) {
			if (!isExitWithOutput(error)) throw error
			return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr }
		}
	}

	startInBackground(command: Command, options: StartInBackgroundOptions): Promise<void> {
		return startInOwnSession(this, command, options)
	}

	readFile(path: string, signal: AbortSignal): Promise<string> {
		return this.#sandbox.files.read(path, { signal: this.#lifetime.bind(signal) })
	}

	async writeFile(path: string, content: string, signal: AbortSignal): Promise<void> {
		const bound = this.#lifetime.bind(signal)
		await this.#sandbox.files.write(`${path}.tmp`, content, { signal: bound })
		await this.#sandbox.files.rename(`${path}.tmp`, path, { signal: bound })
	}

	async pause(signal: AbortSignal): Promise<PausedSandbox> {
		await this.#sandbox.pause({ signal: this.#lifetime.bind(signal) })
		this.#lifetime.untrack(this.id)
		return { backend: 'e2b', id: this.id, spec: this.#spec }
	}

	destroy(signal: AbortSignal): Promise<void> {
		return this.#lifetime.destroy(this.id, signal)
	}
}

/** E2B throws when a command exits with a non-zero code; here that is a result. */
function isExitWithOutput(error: unknown): error is CommandExitError {
	return error instanceof CommandExitError && typeof error.stdout === 'string' && typeof error.stderr === 'string'
}
