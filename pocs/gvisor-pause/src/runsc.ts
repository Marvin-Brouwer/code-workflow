/**
 * Thin wrapper around the runsc CLI. `RUNSC` names the command (default `runsc`; for example
 * `sudo runsc` when the POC doesn't run as root), `POC_RUNSC_PLATFORM` picks the platform
 * (systrap by default, `kvm` where /dev/kvm exists).
 */
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';

export interface RunscOptions {
    /** Container state directory (`--root`). */
    root: string;
    /** Extra global flags, e.g. `--host-uds=open`. */
    flags?: readonly string[];
    signal: AbortSignal;
}

function command(): [string, string[]] {
    const [program = 'runsc', ...prefix] = (process.env.RUNSC ?? 'runsc').split(' ').filter(Boolean);
    return [program, prefix];
}

function globalFlags(options: RunscOptions): string[] {
    const flags = [`--root=${options.root}`, '--network=none', ...(options.flags ?? [])];
    const platform = process.env.POC_RUNSC_PLATFORM;
    if (platform) flags.push(`--platform=${platform}`);
    return flags;
}

export interface RunscResult {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * Runs `runsc <global flags> <args>`. Without `logFile`, output is captured and returned; with it,
 * output goes to that file, which detached containers need: they keep their stdio open.
 */
export function runsc(args: readonly string[], options: RunscOptions & { input?: string; logFile?: string }): Promise<RunscResult> {
    const [program, prefix] = command();
    const log = options.logFile === undefined ? undefined : openSync(options.logFile, 'a');
    const child = spawn(program, [...prefix, ...globalFlags(options), ...args], {
        signal: options.signal,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', log ?? 'pipe', log ?? 'pipe'],
    });
    if (log !== undefined) closeSync(log);
    if (options.input !== undefined) child.stdin?.end(options.input);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => { resolve({ code: code ?? 1, stdout, stderr }); });
    });
}

/** Like `runsc`, but throws with stderr when the command fails. */
export async function runscOk(args: readonly string[], options: RunscOptions & { input?: string; logFile?: string }): Promise<string> {
    const result = await runsc(args, options);
    if (result.code !== 0) throw new Error(`runsc ${args.join(' ')} exited ${String(result.code)}: ${result.stderr.trim()}`);
    return result.stdout;
}
