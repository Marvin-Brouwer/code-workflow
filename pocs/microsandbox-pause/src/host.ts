/**
 * microsandbox backend for the pause checks in @pocs/pause-harness. See ../README.md.
 *
 * A run is a microVM from node:22-slim. Pause is a full snapshot (disk, memory and running
 * processes) followed by killing and removing the sandbox, so nothing of it keeps running on the
 * host; resume restores the snapshot into a new sandbox, where execution continues.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { Destination, type NetworkPolicy, Rule, Sandbox, Snapshot } from 'microsandbox';
import { type Backend, type HostUsage, type RunningSandbox, main, sandboxMemoryMb, stubEnv, stubPath, stubSource } from '@pocs/pause-harness';

const pocDir = path.resolve(import.meta.dirname, '..');
const image = process.env.POC_IMAGE ?? 'node:22-slim';
const cpus = 1;

class MicrosandboxSandbox implements RunningSandbox {
    constructor(readonly sandbox: Sandbox) {}

    async readFile(file: string): Promise<string> {
        return this.sandbox.fs().readToString(file);
    }

    async writeFile(file: string, content: string): Promise<void> {
        // Write to a temporary name and rename, so the stub never reads half a file.
        await this.sandbox.fs().write(`${file}.tmp`, content);
        const moved = await this.sandbox.exec('mv', [`${file}.tmp`, file]);
        if (!moved.success) throw new Error(`mv failed: ${moved.stderr()}`);
    }

    async isAlive(pid: number): Promise<boolean> {
        const result = await this.sandbox.shell(`kill -0 ${String(pid)}`);
        return result.success;
    }

    async destroy(): Promise<void> {
        await removeSandbox(this.sandbox);
    }
}

/** Kills a sandbox (`stop()` would wait for the stub, which never exits on its own) and removes it. */
async function removeSandbox(sandbox: Sandbox) {
    await sandbox.kill();
    try {
        await Sandbox.remove(sandbox.name);
    } catch (error) {
        console.log(`     couldn't remove ${sandbox.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const Paused = z.object({ reference: z.string(), source: z.string() });
type Paused = z.infer<typeof Paused>;

/**
 * microsandbox's processes on this machine. The VMs run in `msb` processes; Windows has no `ps`,
 * so it isn't measured there.
 */
function hostUsage(): HostUsage | undefined {
    if (process.platform === 'win32') return undefined;
    const lines = execFileSync('ps', ['-eo', 'rss=,comm='], { encoding: 'utf8' }).split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([, comm]) => comm?.startsWith('msb'));
    const rssKb = lines.reduce((sum, [rss]) => sum + Number(rss), 0);
    return { processes: lines.length, rssMb: Math.round(rssKb / 1024) };
}

async function create(name: string, configure: (builder: ReturnType<typeof Sandbox.builder>) => ReturnType<typeof Sandbox.builder> = (b) => b) {
    return configure(Sandbox.builder(name).image(image).cpus(cpus).memory(sandboxMemoryMb)).replace().create();
}

const backend: Backend<MicrosandboxSandbox, Paused> = {
    name: 'microsandbox 0.7.13',
    paused: Paused,

    async start() {
        const name = `poc-${String(Date.now())}`;
        const sandbox = await create(name);
        await sandbox.fs().write(stubPath, stubSource);
        const node = await sandbox.exec('node', ['--version']);
        // Not as a managed job (execDetached): microsandbox refuses a full capture while one is
        // active. setsid -f puts the stub in its own session, so it outlives the shell that starts it.
        const env = Object.entries(stubEnv).map(([key, value]) => `${key}='${value}'`).join(' ');
        const started = await sandbox.shell(`${env} setsid -f node ${stubPath} > /var/tmp/stub.log 2>&1 < /dev/null`);
        if (!started.success) throw new Error(`starting the stub failed: ${started.stderr()}`);
        return { sandbox: new MicrosandboxSandbox(sandbox), details: { image, name, node: node.stdout().trim(), cpus, memoryMb: sandboxMemoryMb } };
    },

    async pause({ sandbox }) {
        const snapshot = await Snapshot.builder(`wait-${String(Date.now())}`).fromSandbox(sandbox.name).full().create();
        await removeSandbox(sandbox);
        return {
            paused: { reference: snapshot.reference, source: sandbox.name },
            details: { snapshot: snapshot.id, scope: snapshot.scope, state: snapshot.state.kind, snapshotBytes: snapshot.sizeBytes },
        };
    },

    async resume(paused) {
        // A full restore must use the CPU and memory settings of the capture.
        const sandbox = await Sandbox.restore(paused.reference)
            .name(`${paused.source}-restored-${String(Date.now())}`)
            .cpus(cpus)
            .memory(sandboxMemoryMb)
            .restore();
        return new MicrosandboxSandbox(sandbox);
    },

    hostUsage,

    async egress(allowed, denied) {
        const policy = {
            defaultEgress: 'deny',
            defaultIngress: 'deny',
            rules: [Rule.allowDns(), Rule.allowEgress(Destination.domain(allowed))],
        } satisfies NetworkPolicy;
        const sandbox = await create(`poc-egress-${String(Date.now())}`, (b) => b.network((network: { policy(p: NetworkPolicy): unknown }) => network.policy(policy)));
        try {
            const probe = async (host: string) => {
                const script = `fetch('https://${host}/', { signal: AbortSignal.timeout(10000) }).then((r) => console.log(r.status), (e) => { console.log('000'); console.error(String(e.cause?.code ?? e.cause ?? e)); })`;
                const output = await sandbox.exec('node', ['-e', script]);
                const error = output.stderr().trim();
                if (error) console.log(`     ${host}: ${error}`);
                return output.stdout().trim() || '000';
            };
            return { allowed: await probe(allowed), denied: await probe(denied) };
        } finally {
            await removeSandbox(sandbox);
        }
    },
};

await main(backend, pocDir, process.argv[2] ?? 'run');
