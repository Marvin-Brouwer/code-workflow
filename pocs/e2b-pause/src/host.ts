/**
 * Host side of the E2B pause POC. See ../README.md for what it proves and how to run it.
 *
 *   run      start the stub, pause, resume, answer, verify — all in one process
 *   pause    start the stub and pause; remembers the sandbox in .work/sandbox.json
 *   resume   resume the remembered sandbox, answer, verify (run after restarting E2B)
 *   egress   check that sandbox egress can be limited to an allowlist
 *
 * Connection settings come from the environment, as the E2B SDK reads them (E2B_API_KEY,
 * E2B_API_URL, E2B_SANDBOX_URL). For E2B Embed: eval "$(docker compose exec ready cat /run/e2b/sdk.env)",
 * or, with the Windows container, .work/sdk.env is loaded automatically.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Sandbox } from 'e2b';

const pocDir = path.resolve(import.meta.dirname, '..');
const workDir = path.join(pocDir, '.work');
const stateDir = '/home/user/state';
const stubPath = '/home/user/stub.mjs';
const tickPort = 8080;
const sandboxTimeoutMs = 30 * 60 * 1000;

interface Waiting { pid: number; token: string; memoryMb: number; checksum: string; waitingAt: number; stack: string }
interface Done {
    pid: number;
    token: string;
    checksum: string;
    answer: { approved: boolean };
    waitedMs: number;
    timeout: { scheduledAt: number; dueAt: number; firedAt: number | null };
    largestTickGapMs: number;
    stack: string;
    doneAt: number;
}
interface Remembered { sandboxId: string; waiting: Waiting; pausedAt: number; hostBefore: HostUsage; hostPaused: HostUsage }
interface HostUsage { processes: number; rssMb: number }

/**
 * Loads the SDK settings the Windows container writes to .work/sdk.env, unless the environment
 * already has them (as after `eval "$(docker compose exec ready cat /run/e2b/sdk.env)"`).
 */
function loadSdkEnv() {
    const file = path.join(workDir, 'sdk.env');
    if (process.env.E2B_API_URL) return;
    if (!existsSync(file)) {
        throw new Error(`No E2B settings: E2B_API_URL is unset and ${path.relative(process.cwd(), file)} doesn't exist. Start Embed first (README, Prerequisites).`);
    }
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const match = /^(?:export\s+)?(E2B_[A-Z_]+)=(.*)$/.exec(line.trim());
        if (match?.[1] && match[2] !== undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
    console.log(`     SDK settings from ${path.relative(process.cwd(), file)}`);
}

const report: Record<string, unknown> = { startedAt: new Date().toISOString(), sdk: 'e2b ~2.46.1' };
const results: { name: string; ok: boolean; detail: string }[] = [];

function record(name: string, ok: boolean, detail: string) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
    const started = performance.now();
    const value = await work();
    return { value, ms: Math.round(performance.now() - started) };
}

/** Firecracker processes on this machine. Only meaningful when the script runs on the E2B host itself. */
function hostUsage(): HostUsage {
    // Firecracker only runs on a Linux host; elsewhere (Windows, where it runs inside the windows/
    // container) there is nothing to see, and Git Bash's ps doesn't know -C.
    if (process.platform !== 'linux') return { processes: 0, rssMb: 0 };
    try {
        const rss = execFileSync('ps', ['-C', 'firecracker', '-o', 'rss='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .split('\n').map((line) => Number(line.trim())).filter((kb) => kb > 0);
        return { processes: rss.length, rssMb: Math.round(rss.reduce((sum, kb) => sum + kb, 0) / 1024) };
    } catch {
        return { processes: 0, rssMb: 0 }; // ps exits 1 when nothing matches
    }
}

/** Size of E2B's snapshot storage, when E2B_SNAPSHOT_DIR points at it. */
function snapshotBytes(): number | undefined {
    const directory = process.env.E2B_SNAPSHOT_DIR;
    if (!directory) return undefined;
    const [bytes] = execFileSync('du', ['-sb', directory], { encoding: 'utf8' }).split('\t');
    return Number(bytes);
}

async function readJson<T>(sandbox: Sandbox, file: string, signal: AbortSignal, timeoutMs = 120_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        signal.throwIfAborted();
        try {
            return JSON.parse(await sandbox.files.read(file, { requestTimeoutMs: 10_000 })) as T;
        } catch (error) {
            if (Date.now() > deadline) throw new Error(`${file} didn't appear within ${String(timeoutMs)} ms`, { cause: error });
            await sleep(500, undefined, { signal });
        }
    }
}

/**
 * Opens GET /ticks on the stub and records what happens to the stream while the sandbox pauses.
 * With E2B_SANDBOX_URL set (Embed), the request goes through that proxy and names the sandbox and
 * port in headers, the way the SDK reaches a sandbox there; otherwise it uses the sandbox's host.
 */
function watchTicks(sandbox: Sandbox, signal: AbortSignal) {
    const proxy = process.env.E2B_SANDBOX_URL;
    const url = proxy ? `${proxy}/ticks` : `https://${sandbox.getHost(tickPort)}/ticks`;
    const headers = proxy ? { 'E2b-Sandbox-Id': sandbox.sandboxId, 'E2b-Sandbox-Port': String(tickPort) } : {};
    const state = { url, lines: 0, ended: null as string | null };
    const stream = (async () => {
        try {
            const response = await fetch(url, { headers, signal });
            if (!response.ok || !response.body) throw new Error(`status ${String(response.status)}`);
            for await (const chunk of response.body) state.lines += String(chunk).split('\n').length - 1;
            state.ended = 'closed by the other side';
        } catch (error) {
            state.ended = `error: ${error instanceof Error ? error.message : String(error)}`;
        }
    })();
    return { state, stream };
}

async function startStub(signal: AbortSignal) {
    const created = await timed(() => Sandbox.create({ timeoutMs: sandboxTimeoutMs, signal }));
    const sandbox = created.value;
    report.sandboxId = sandbox.sandboxId;
    report.createMs = created.ms;
    console.log(`     sandbox ${sandbox.sandboxId} created in ${String(created.ms)} ms`);

    const node = await sandbox.commands.run('node --version', { signal });
    if (node.exitCode !== 0) throw new Error(`No Node in the sandbox template: ${node.stderr}`);
    const free = await sandbox.commands.run(`awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo`, { signal });
    const totalMb = Number(free.stdout.trim());
    const memoryMb = Math.min(500, Math.floor(totalMb * 0.5));
    report.sandbox = { node: node.stdout.trim(), totalMemoryMb: totalMb, stubMemoryMb: memoryMb };

    await sandbox.files.write(stubPath, readFileSync(path.join(pocDir, 'src/stub.mjs'), 'utf8'));
    await sandbox.commands.run(`node ${stubPath}`, {
        background: true,
        envs: { STATE_DIR: stateDir, STUB_MEMORY_MB: String(memoryMb), TICK_PORT: String(tickPort) },
        timeoutMs: 0,
    });
    const waiting = await readJson<Waiting>(sandbox, `${stateDir}/waiting.json`, signal);
    console.log(`     stub waiting: pid ${String(waiting.pid)}, ${String(waiting.memoryMb)} MB ballast`);
    return { sandbox, waiting };
}

async function pause(sandbox: Sandbox, signal: AbortSignal) {
    const before = hostUsage();
    const paused = await timed(() => sandbox.pause({ signal }));
    const during = hostUsage();
    report.pauseMs = paused.ms;
    report.snapshotBytes = snapshotBytes() ?? 'not measured (set E2B_SNAPSHOT_DIR)';
    report.hostUsage = { before, paused: during };
    console.log(`     paused in ${String(paused.ms)} ms`);
    return { before, during };
}

function checkHostUsage(before: HostUsage, paused: HostUsage) {
    if (before.processes === 0) {
        record('no CPU or RAM while paused', true, 'not measured: no firecracker processes visible, run this on the E2B host');
        return;
    }
    record('no CPU or RAM while paused', paused.processes < before.processes,
        `firecracker processes ${String(before.processes)} → ${String(paused.processes)}, RSS ${String(before.rssMb)} → ${String(paused.rssMb)} MB`);
}

async function resumeAndVerify(sandboxId: string, waiting: Waiting, signal: AbortSignal) {
    const resumed = await timed(() => Sandbox.connect(sandboxId, { timeoutMs: sandboxTimeoutMs, signal }));
    const sandbox = resumed.value;
    report.resumeMs = resumed.ms;
    console.log(`     resumed in ${String(resumed.ms)} ms`);

    const alive = await sandbox.commands.run(`kill -0 ${String(waiting.pid)}`, { signal });
    record('stub process survived', alive.exitCode === 0, `pid ${String(waiting.pid)} ${alive.exitCode === 0 ? 'is' : 'is not'} running`);

    await sandbox.files.write(`${stateDir}/answer.json`, JSON.stringify({ approved: true }));
    const done = await readJson<Done>(sandbox, `${stateDir}/done.json`, signal, 30_000);

    record('pending await resolved', done.answer.approved, `answered after ${String(done.waitedMs)} ms of waiting`);
    record('same process', done.pid === waiting.pid, `pid ${String(waiting.pid)} → ${String(done.pid)}`);
    record('memory intact', done.token === waiting.token && done.checksum === waiting.checksum,
        `token ${done.token === waiting.token ? 'same' : 'changed'}, ${String(waiting.memoryMb)} MB checksum ${done.checksum === waiting.checksum ? 'same' : 'changed'}`);
    const frames = ['at input', 'at async loop', 'at async workflow'].filter((frame) => done.stack.includes(frame));
    record('original stack', frames.length === 3, `found ${frames.join(', ') || 'none'} in the stack after resume`);

    report.clock = {
        largestTickGapMs: done.largestTickGapMs,
        timeoutDueAfterMs: done.timeout.dueAt - done.timeout.scheduledAt,
        timeoutFiredAfterMs: done.timeout.firedAt === null ? null : done.timeout.firedAt - done.timeout.scheduledAt,
        note: 'a tick gap close to the pause length means Date.now() jumped; compare the timeout with its due time',
    };
    report.stackAfterResume = done.stack;
    await sandbox.kill({ signal });
}

function remember(remembered: Remembered) {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(path.join(workDir, 'sandbox.json'), JSON.stringify(remembered, null, 2));
}

function recall(): Remembered {
    return JSON.parse(readFileSync(path.join(workDir, 'sandbox.json'), 'utf8')) as Remembered;
}

async function run(signal: AbortSignal) {
    const { sandbox, waiting } = await startStub(signal);
    const ticks = watchTicks(sandbox, signal);
    await sleep(3000, undefined, { signal });

    const usage = await pause(sandbox, signal);
    checkHostUsage(usage.before, usage.during);
    await sleep(Number(process.env.POC_PAUSE_SECONDS ?? '60') * 1000, undefined, { signal });

    const linesBeforeResume = ticks.state.lines;
    await resumeAndVerify(sandbox.sandboxId, waiting, signal);
    await Promise.race([ticks.stream, sleep(5000)]);
    report.openStream = { ...ticks.state, linesBeforeResume };
}

async function pauseOnly(signal: AbortSignal) {
    const { sandbox, waiting } = await startStub(signal);
    const usage = await pause(sandbox, signal);
    remember({ sandboxId: sandbox.sandboxId, waiting, pausedAt: Date.now(), hostBefore: usage.before, hostPaused: usage.during });
    console.log('     paused. Restart the E2B service (docker compose restart), then: pnpm poc:e2b-pause resume');
}

async function resumeOnly(signal: AbortSignal) {
    const remembered = recall();
    report.sandboxId = remembered.sandboxId;
    report.pausedForMs = Date.now() - remembered.pausedAt;
    checkHostUsage(remembered.hostBefore, remembered.hostPaused);
    await resumeAndVerify(remembered.sandboxId, remembered.waiting, signal);
}

/** Allow one host, deny everything else, and check both from inside the sandbox. */
async function egress(signal: AbortSignal) {
    const allowed = process.env.POC_EGRESS_ALLOWED ?? 'registry.npmjs.org';
    const denied = process.env.POC_EGRESS_DENIED ?? 'example.com';
    const sandbox = await Sandbox.create({
        timeoutMs: 5 * 60 * 1000,
        network: { allowOut: [allowed], denyOut: ({ allTraffic }) => [allTraffic] },
        signal,
    });
    const probe = (host: string) => sandbox.commands.run(
        `curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://${host}/ || true`, { signal });
    const [allowedResult, deniedResult] = [await probe(allowed), await probe(denied)];
    record('egress allowlist: allowed host reachable', allowedResult.stdout.trim() !== '000', `${allowed} → ${allowedResult.stdout.trim()}`);
    record('egress allowlist: other host blocked', deniedResult.stdout.trim() === '000', `${denied} → ${deniedResult.stdout.trim()}`);
    await sandbox.kill({ signal });
}

const commands: Record<string, (signal: AbortSignal) => Promise<void>> = { run, pause: pauseOnly, resume: resumeOnly, egress };
const command = process.argv[2] ?? 'run';
const handler = commands[command];
if (!handler) {
    console.error(`Unknown command '${command}'. Use one of: ${Object.keys(commands).join(', ')}`);
    process.exit(2);
}

loadSdkEnv();
const controller = new AbortController();
process.once('SIGINT', () => { controller.abort(new Error('interrupted')); });

try {
    await handler(controller.signal);
} finally {
    report.command = command;
    report.results = results;
    mkdirSync(workDir, { recursive: true });
    const file = path.join(workDir, `report-${command}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`     report: ${path.relative(process.cwd(), file)}`);
}
if (results.some((result) => !result.ok)) process.exitCode = 1;
