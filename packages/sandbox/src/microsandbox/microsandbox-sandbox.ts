import { Sandbox as MicrosandboxSdkSandbox, Snapshot } from 'microsandbox';
import { abortable } from '../abortable.ts';
import type { BackendLifetime } from '../backend-lifetime.ts';
import type { PausedSandbox } from '../paused-sandbox.ts';
import type { Command, ExecOptions, ExecResult, Sandbox } from '../sandbox.ts';
import type { SandboxSpec } from '../sandbox-spec.ts';
import { sandboxIdOfSnapshot, snapshotName } from './snapshot-name.ts';

/**
 * A running microVM. Its microsandbox name is the sandbox id.
 *
 * The SDK takes no abort signals: calls are raced against the signal, and a command that is
 * still running when the signal aborts is killed.
 */
export class MicrosandboxSandbox implements Sandbox {
    readonly #sandbox: MicrosandboxSdkSandbox;
    readonly #spec: SandboxSpec;
    readonly #lifetime: BackendLifetime;

    constructor(sandbox: MicrosandboxSdkSandbox, spec: SandboxSpec, lifetime: BackendLifetime) {
        this.#sandbox = sandbox;
        this.#spec = spec;
        this.#lifetime = lifetime;
        lifetime.track(this.id, (signal) => abortable(removeSandbox(sandbox), signal));
    }

    get id(): string {
        return this.#sandbox.name;
    }

    async exec(command: Command, options: ExecOptions): Promise<ExecResult> {
        const signal = this.#lifetime.signal(options.signal);
        const [program, ...args] = command;
        const handle = await abortable(
            this.#sandbox.execStreamWith(program, (builder) => {
                const withArgs = builder.args(args).envs({ ...options.env });
                return options.cwd === undefined ? withArgs : withArgs.cwd(options.cwd);
            }),
            signal,
            (late) => late.kill(),
        );
        const kill = () => {
            handle.kill().catch(() => undefined);
        };
        signal.addEventListener('abort', kill, { once: true });
        try {
            const output = await abortable(handle.collect(), signal);
            return { exitCode: output.code, stdout: output.stdout(), stderr: output.stderr() };
        } finally {
            signal.removeEventListener('abort', kill);
        }
    }

    readFile(path: string, signal: AbortSignal): Promise<string> {
        return abortable(this.#sandbox.fs().readToString(path), this.#lifetime.signal(signal));
    }

    async writeFile(path: string, content: string, signal: AbortSignal): Promise<void> {
        const combined = this.#lifetime.signal(signal);
        await abortable(this.#sandbox.fs().write(`${path}.tmp`, content), combined);
        await abortable(this.#sandbox.fs().rename(`${path}.tmp`, path), combined);
    }

    /**
     * A full snapshot (disk, memory and processes), then the VM is killed and removed. microsandbox
     * refuses a full snapshot while it manages a running job, see `startInBackground`.
     */
    async pause(signal: AbortSignal): Promise<PausedSandbox> {
        const combined = this.#lifetime.signal(signal);
        const snapshot = await abortable(Snapshot.builder(snapshotName(this.id)).fromSandbox(this.id).full().create(), combined);
        await abortable(removeSandbox(this.#sandbox), combined);
        this.#lifetime.untrack(this.id);
        // Housekeeping only: neither a failure nor an abort here may lose the pause that just worked.
        await abortable(removeOlderSnapshots(this.id, snapshot.reference), combined).catch(() => undefined);
        return { backend: 'microsandbox', id: this.id, spec: this.#spec, snapshot: snapshot.reference };
    }

    async destroy(signal: AbortSignal): Promise<void> {
        await abortable(removeSandbox(this.#sandbox), this.#lifetime.signal(signal));
        this.#lifetime.untrack(this.id);
    }
}

/** Kills rather than stops: `stop()` waits for the processes in it, which may never exit. */
export async function removeSandbox(sandbox: MicrosandboxSdkSandbox): Promise<void> {
    await sandbox.kill();
    await MicrosandboxSdkSandbox.remove(sandbox.name);
}

/**
 * Earlier pauses of the same sandbox. microsandbox refuses to remove a snapshot another one
 * depends on, and that refusal is fine: it stays until the sandbox is removed.
 */
async function removeOlderSnapshots(id: string, keep: string): Promise<void> {
    for (const snapshot of await Snapshot.list()) {
        if (snapshot.reference === keep || snapshot.name === null || sandboxIdOfSnapshot(snapshot.name) !== id) continue;
        await Snapshot.remove(snapshot.name).catch(() => undefined);
    }
}
