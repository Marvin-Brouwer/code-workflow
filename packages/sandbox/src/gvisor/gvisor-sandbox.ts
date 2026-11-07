import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { PausedSandbox } from '../paused-sandbox.ts';
import type { Command, ExecOptions, ExecResult, Sandbox } from '../sandbox.ts';
import type { SandboxSpec } from '../sandbox-spec.ts';
import type { GvisorContext } from './gvisor-context.ts';
import { runsc, runscOk } from './runsc.ts';

/** A running gVisor container. Its runsc container id is the sandbox id. */
export class GvisorSandbox implements Sandbox {
    readonly #spec: SandboxSpec;
    readonly #context: GvisorContext;

    constructor(readonly id: string, spec: SandboxSpec, context: GvisorContext) {
        this.#spec = spec;
        this.#context = context;
        context.lifetime.track(id, (signal) => context.remove(id, signal));
    }

    async exec(command: Command, options: ExecOptions): Promise<ExecResult> {
        const flags = Object.entries(options.env ?? {}).map(([key, value]) => `--env=${key}=${value}`);
        if (options.cwd !== undefined) flags.push(`--cwd=${options.cwd}`);
        const result = await runsc(this.#context.runsc, ['exec', ...flags, this.id, ...command], {
            signal: this.#context.lifetime.signal(options.signal),
        });
        return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    }

    async readFile(file: string, signal: AbortSignal): Promise<string> {
        const result = await this.exec(['cat', file], { signal });
        if (result.exitCode !== 0) throw new Error(`Reading ${file} failed: ${result.stderr.trim()}`);
        return result.stdout;
    }

    async writeFile(file: string, content: string, signal: AbortSignal): Promise<void> {
        const script = 'cat > "$1.tmp" && mv "$1.tmp" "$1"';
        await runscOk(this.#context.runsc, ['exec', this.id, 'sh', '-c', script, 'sh', file], {
            signal: this.#context.lifetime.signal(signal),
            input: content,
        });
    }

    /**
     * `runsc checkpoint` writes memory, processes and the in-memory filesystem to disk and ends the
     * sandbox. It takes as long as writing the sandbox's memory takes: under a second on a fast
     * disk, seconds on a slow one.
     */
    async pause(signal: AbortSignal): Promise<PausedSandbox> {
        const combined = this.#context.lifetime.signal(signal);
        const { checkpoints } = this.#context.layout.sandbox(this.id);
        const name = Date.now().toString(36);
        const partial = path.join(checkpoints, `${name}.partial`);
        await mkdir(partial, { recursive: true });
        await runscOk(this.#context.runsc, ['checkpoint', `--image-path=${partial}`, this.id], { signal: combined });
        await rename(partial, path.join(checkpoints, name));
        this.#context.lifetime.untrack(this.id);
        // Housekeeping from here on: a failure may not lose the pause that just worked. Resume
        // deletes a leftover container record itself.
        await runsc(this.#context.runsc, ['delete', '--force', this.id], { signal: combined }).catch(() => undefined);
        await this.#context.stopEgress(this.id);
        await removeOtherCheckpoints(checkpoints, name).catch(() => undefined);
        return { backend: 'gvisor', id: this.id, spec: this.#spec, snapshot: name };
    }

    async destroy(signal: AbortSignal): Promise<void> {
        await this.#context.remove(this.id, this.#context.lifetime.signal(signal));
        this.#context.lifetime.untrack(this.id);
    }
}

/** Earlier pauses. Nothing reads them once the sandbox that came from them has stopped. */
async function removeOtherCheckpoints(checkpoints: string, keep: string): Promise<void> {
    for (const entry of await readdir(checkpoints)) {
        if (entry !== keep) await rm(path.join(checkpoints, entry), { recursive: true, force: true });
    }
}
