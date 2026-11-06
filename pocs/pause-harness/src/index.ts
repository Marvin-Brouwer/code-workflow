/**
 * The pause checks shared by the sandbox POCs: one stub, one set of criteria, one report format,
 * so every backend is measured the same way (docs/plans/poc-e2b-pause.md).
 *
 * A backend only knows how to start the stub, pause it to disk and resume it. This module runs the
 * commands, polls the stub's files and records the results.
 *
 *   run      start the stub, pause, wait, resume, answer, verify — all in one process
 *   pause    start the stub and pause; remembers the paused sandbox in .work/paused.json
 *   resume   resume the remembered sandbox, answer, verify (run after a restart)
 *   egress   check that sandbox egress can be limited to an allowlist
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

/** Where the stub keeps its files inside every sandbox. */
export const stateDir = '/var/tmp/poc-state';
/** Path of the stub inside every sandbox. */
export const stubPath = '/var/tmp/stub.mjs';
/** Every backend gives the sandbox this much memory; the stub fills about half of it. */
export const sandboxMemoryMb = 1024;
export const stubMemoryMb = 500;
export const tickPort = 8080;

/** The stub's source, uploaded by each backend. */
export const stubSource = readFileSync(new URL('stub.mjs', import.meta.url), 'utf8');

/** Environment the stub expects. */
export const stubEnv: Readonly<Record<string, string>> = {
    STATE_DIR: stateDir,
    STUB_MEMORY_MB: String(stubMemoryMb),
    TICK_PORT: String(tickPort),
};

export const Waiting = z.object({
    pid: z.number(),
    token: z.string(),
    memoryMb: z.number(),
    checksum: z.string(),
    waitingAt: z.number(),
    stack: z.string(),
});
export type Waiting = z.infer<typeof Waiting>;

const Done = z.object({
    pid: z.number(),
    token: z.string(),
    checksum: z.string(),
    answer: z.object({ approved: z.boolean() }),
    waitedMs: z.number(),
    timeout: z.object({ scheduledAt: z.number(), dueAt: z.number(), firedAt: z.number().nullable() }),
    largestTickGapMs: z.number(),
    stack: z.string(),
    doneAt: z.number(),
});

/** Processes and memory the backend holds on this machine for the POC's sandboxes. */
export const HostUsage = z.object({ processes: z.number(), rssMb: z.number() });
export type HostUsage = z.infer<typeof HostUsage>;

/** A sandbox with the stub running in it. */
export interface RunningSandbox {
    readFile(file: string, signal: AbortSignal): Promise<string>;
    writeFile(file: string, content: string, signal: AbortSignal): Promise<void>;
    isAlive(pid: number, signal: AbortSignal): Promise<boolean>;
    destroy(signal: AbortSignal): Promise<void>;
}

export interface EgressProbe {
    /** HTTP status of a request to the allowed host, or '000' when it failed. */
    allowed: string;
    /** Same for a host that isn't on the allowlist. */
    denied: string;
}

export interface Backend<Sandbox extends RunningSandbox, Paused> {
    /** Name and version, for the report. */
    readonly name: string;
    /** Schema of what `pause` returns, so `resume` can read it back from disk. */
    readonly paused: z.ZodType<Paused>;
    /** Creates a sandbox with `sandboxMemoryMb` of memory and starts the stub with `stubEnv`. */
    start(signal: AbortSignal): Promise<{ sandbox: Sandbox; details: Record<string, unknown> }>;
    /** Saves memory, processes and disk to the machine's disk, and frees the sandbox's CPU and RAM. */
    pause(sandbox: Sandbox, signal: AbortSignal): Promise<{ paused: Paused; details: Record<string, unknown> }>;
    /** Brings a paused sandbox back with its processes running. */
    resume(paused: Paused, signal: AbortSignal): Promise<Sandbox>;
    /** The backend's processes on this machine, when it can see them. */
    hostUsage(): HostUsage | undefined;
    /** Starts a sandbox that may reach `allowed` only, and probes both hosts from inside it. */
    egress(allowed: string, denied: string, signal: AbortSignal): Promise<EgressProbe>;
}

interface Result {
    name: string;
    ok: boolean;
    detail: string;
}

class Report {
    readonly data: Record<string, unknown> = { startedAt: new Date().toISOString() };
    readonly results: Result[] = [];

    record(name: string, ok: boolean, detail: string) {
        this.results.push({ name, ok, detail });
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
    }

    note(message: string) {
        console.log(`     ${message}`);
    }
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
    const started = performance.now();
    const value = await work();
    return { value, ms: Math.round(performance.now() - started) };
}

async function readJson<T>(
    schema: z.ZodType<T>,
    sandbox: RunningSandbox,
    file: string,
    signal: AbortSignal,
    timeoutMs = 120_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        signal.throwIfAborted();
        try {
            return schema.parse(JSON.parse(await sandbox.readFile(file, signal)));
        } catch (error) {
            if (signal.aborted) throw error;
            if (Date.now() > deadline) throw new Error(`${file} didn't appear within ${String(timeoutMs)} ms`, { cause: error });
            await sleep(500, undefined, { signal });
        }
    }
}

const Remembered = z.object({
    paused: z.unknown(),
    waiting: Waiting,
    pausedAt: z.number(),
    hostBefore: HostUsage.optional(),
    hostPaused: HostUsage.optional(),
});

function checkHostUsage(report: Report, before: HostUsage | undefined, paused: HostUsage | undefined) {
    if (!before || !paused || before.processes === 0) {
        report.record('no CPU or RAM while paused', true, 'not measured: no backend processes visible from here');
        return;
    }
    report.record('no CPU or RAM while paused', paused.processes < before.processes,
        `processes ${String(before.processes)} → ${String(paused.processes)}, RSS ${String(before.rssMb)} → ${String(paused.rssMb)} MB`);
}

/**
 * Runs one POC command against a backend and writes the report to `<pocDir>/.work`.
 * Sets a non-zero exit code when a check fails.
 */
export async function main<Sandbox extends RunningSandbox, Paused>(
    backend: Backend<Sandbox, Paused>,
    pocDir: string,
    command: string,
): Promise<void> {
    const workDir = path.join(pocDir, '.work');
    const rememberedFile = path.join(workDir, 'paused.json');
    const report = new Report();
    report.data.backend = backend.name;

    async function startStub(signal: AbortSignal) {
        const started = await timed(() => backend.start(signal));
        report.data.createMs = started.ms;
        report.data.sandbox = started.value.details;
        report.note(`sandbox started in ${String(started.ms)} ms`);
        const waiting = await readJson(Waiting, started.value.sandbox, `${stateDir}/waiting.json`, signal);
        report.note(`stub waiting: pid ${String(waiting.pid)}, ${String(waiting.memoryMb)} MB ballast`);
        // A few one-second ticks before the pause, so the tick gap afterwards shows what the clock did.
        await sleep(3000, undefined, { signal });
        return { sandbox: started.value.sandbox, waiting };
    }

    async function pause(sandbox: Sandbox, signal: AbortSignal) {
        const before = backend.hostUsage();
        const paused = await timed(() => backend.pause(sandbox, signal));
        const during = backend.hostUsage();
        report.data.pauseMs = paused.ms;
        report.data.pause = paused.value.details;
        report.data.hostUsage = { before, paused: during };
        report.note(`paused in ${String(paused.ms)} ms`);
        return { paused: paused.value.paused, before, during };
    }

    async function resumeAndVerify(paused: Paused, waiting: Waiting, signal: AbortSignal) {
        const resumed = await timed(() => backend.resume(paused, signal));
        const sandbox = resumed.value;
        report.data.resumeMs = resumed.ms;
        report.note(`resumed in ${String(resumed.ms)} ms`);
        try {
            const alive = await sandbox.isAlive(waiting.pid, signal);
            report.record('stub process survived', alive, `pid ${String(waiting.pid)} ${alive ? 'is' : 'is not'} running`);

            await sandbox.writeFile(`${stateDir}/answer.json`, JSON.stringify({ approved: true }), signal);
            const done = await readJson(Done, sandbox, `${stateDir}/done.json`, signal, 30_000);

            report.record('pending await resolved', done.answer.approved, `answered after ${String(done.waitedMs)} ms of waiting`);
            report.record('same process', done.pid === waiting.pid, `pid ${String(waiting.pid)} → ${String(done.pid)}`);
            report.record('memory intact', done.token === waiting.token && done.checksum === waiting.checksum,
                `token ${done.token === waiting.token ? 'same' : 'changed'}, ${String(waiting.memoryMb)} MB checksum ${done.checksum === waiting.checksum ? 'same' : 'changed'}`);
            const frames = ['at input', 'at async loop', 'at async workflow'].filter((frame) => done.stack.includes(frame));
            report.record('original stack', frames.length === 3, `found ${frames.join(', ') || 'none'} in the stack after resume`);

            report.data.clock = {
                largestTickGapMs: done.largestTickGapMs,
                timeoutDueAfterMs: done.timeout.dueAt - done.timeout.scheduledAt,
                timeoutFiredAfterMs: done.timeout.firedAt === null ? null : done.timeout.firedAt - done.timeout.scheduledAt,
                note: 'a tick gap close to the pause length means Date.now() jumped; compare the timeout with its due time',
            };
            report.data.stackAfterResume = done.stack;
        } finally {
            await sandbox.destroy(signal);
        }
    }

    const commands: Record<string, (signal: AbortSignal) => Promise<void>> = {
        async run(signal) {
            const { sandbox, waiting } = await startStub(signal);
            const usage = await pause(sandbox, signal);
            checkHostUsage(report, usage.before, usage.during);
            const seconds = Number(process.env.POC_PAUSE_SECONDS ?? '60');
            report.note(`waiting ${String(seconds)} s while paused (POC_PAUSE_SECONDS)`);
            await sleep(seconds * 1000, undefined, { signal });
            await resumeAndVerify(usage.paused, waiting, signal);
        },
        async pause(signal) {
            const { sandbox, waiting } = await startStub(signal);
            const usage = await pause(sandbox, signal);
            mkdirSync(workDir, { recursive: true });
            writeFileSync(rememberedFile, JSON.stringify({
                paused: usage.paused, waiting, pausedAt: Date.now(), hostBefore: usage.before, hostPaused: usage.during,
            }, null, 2));
            report.note(`paused; remembered in ${path.relative(process.cwd(), rememberedFile)}. Restart, then run resume.`);
        },
        async resume(signal) {
            if (!existsSync(rememberedFile)) {
                throw new Error(`Nothing paused: ${path.relative(process.cwd(), rememberedFile)} doesn't exist. Run pause first.`);
            }
            const remembered = Remembered.parse(JSON.parse(readFileSync(rememberedFile, 'utf8')));
            report.data.pausedForMs = Date.now() - remembered.pausedAt;
            checkHostUsage(report, remembered.hostBefore, remembered.hostPaused);
            await resumeAndVerify(backend.paused.parse(remembered.paused), remembered.waiting, signal);
        },
        async egress(signal) {
            const allowed = process.env.POC_EGRESS_ALLOWED ?? 'registry.npmjs.org';
            const denied = process.env.POC_EGRESS_DENIED ?? 'example.com';
            const probe = await backend.egress(allowed, denied, signal);
            report.record('egress allowlist: allowed host reachable', probe.allowed !== '000', `${allowed} → ${probe.allowed}`);
            report.record('egress allowlist: other host blocked', probe.denied === '000', `${denied} → ${probe.denied}`);
        },
    };

    const handler = commands[command];
    if (!handler) {
        console.error(`Unknown command '${command}'. Use one of: ${Object.keys(commands).join(', ')}`);
        process.exitCode = 2;
        return;
    }

    const controller = new AbortController();
    const interrupt = () => { controller.abort(new Error('interrupted')); };
    process.once('SIGINT', interrupt);
    try {
        await handler(controller.signal);
    } finally {
        process.off('SIGINT', interrupt);
        report.data.command = command;
        report.data.results = report.results;
        mkdirSync(workDir, { recursive: true });
        const file = path.join(workDir, `report-${command}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        writeFileSync(file, JSON.stringify(report.data, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2));
        report.note(`report: ${path.relative(process.cwd(), file)}`);
    }
    if (report.results.some((result) => !result.ok)) process.exitCode = 1;
}
