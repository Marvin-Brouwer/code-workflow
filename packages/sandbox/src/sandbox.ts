import type { PausedSandbox } from './paused-sandbox.ts';

/** A program and its arguments. Never run through a shell, so nothing needs quoting. */
export type Command = readonly [program: string, ...args: string[]];

export interface ExecOptions {
    readonly signal: AbortSignal;
    /** Added to the sandbox's own environment for this command. */
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
}

export interface ExecResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

/**
 * A running sandbox. Once it is paused or destroyed this object is done: resume gives a new one.
 *
 * Every method takes an `AbortSignal`. Aborting settles the call right away; work the backend
 * can't cancel (an SDK call without a signal) finishes in the background and is cleaned up.
 */
export interface Sandbox {
    /** Stays the same across a pause and resume. */
    readonly id: string;
    /** Runs a command to the end. A non-zero exit code is a result, not an error. */
    exec(command: Command, options: ExecOptions): Promise<ExecResult>;
    readFile(path: string, signal: AbortSignal): Promise<string>;
    /** Writes to a temporary file and renames it, so a reader never sees half a file. */
    writeFile(path: string, content: string, signal: AbortSignal): Promise<void>;
    /**
     * Saves memory, processes and disk, then stops the sandbox so it holds no CPU or RAM.
     * Open connections into or out of the sandbox don't survive this.
     */
    pause(signal: AbortSignal): Promise<PausedSandbox>;
    destroy(signal: AbortSignal): Promise<void>;
}
