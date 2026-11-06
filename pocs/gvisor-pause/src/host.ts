/**
 * gVisor backend for the pause checks in @pocs/pause-harness. See ../README.md.
 *
 * A run is an OCI bundle (node:22-slim unpacked by ./image.ts) started with `runsc run`, without
 * network (`--network=none`). Pause is `runsc checkpoint`, which writes memory, processes and the
 * sandbox's in-memory filesystem to an image directory and ends the sandbox; resume is
 * `runsc restore` from that directory into a new container.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type Backend, type HostUsage, type RunningSandbox, main, stubEnv, stubPath, stubSource } from '@pocs/pause-harness';
import { pullRootfs } from './image.js';
import { probeScript, startGateway } from './gateway.js';
import { runsc, runscOk, type RunscOptions } from './runsc.js';

const pocDir = path.resolve(import.meta.dirname, '..');
const workDir = path.join(pocDir, '.work');
const root = path.join(workDir, 'runsc-state');
const image = process.env.POC_IMAGE ?? 'node:22-slim';
const rootfs = path.join(workDir, 'rootfs');
const defaultPath = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

interface Mount {
    destination: string;
    source: string;
}

const capabilities = ['CAP_AUDIT_WRITE', 'CAP_KILL', 'CAP_NET_BIND_SERVICE'];

/**
 * Writes an OCI bundle around the shared rootfs: the spec `runsc spec` generates, with our process,
 * env and mounts. Written here rather than by `runsc spec`, because with `RUNSC='sudo runsc'` that
 * file would belong to root.
 */
function bundle(name: string, args: readonly string[], env: Readonly<Record<string, string>>, mounts: readonly Mount[]) {
    const directory = path.join(workDir, 'bundles', name);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const config = {
        ociVersion: '1.0.0',
        process: {
            user: { uid: 0, gid: 0 },
            args,
            env: [defaultPath, ...Object.entries(env).map(([key, value]) => `${key}=${value}`)],
            cwd: '/',
            capabilities: { bounding: capabilities, effective: capabilities, inheritable: capabilities, permitted: capabilities },
            rlimits: [{ type: 'RLIMIT_NOFILE', hard: 1024, soft: 1024 }],
        },
        // Writes inside the sandbox land in gVisor's in-memory overlay, so they are part of a checkpoint.
        root: { path: rootfs, readonly: false },
        hostname: 'runsc',
        mounts: [
            { destination: '/proc', type: 'proc', source: 'proc' },
            { destination: '/dev', type: 'tmpfs', source: 'tmpfs' },
            { destination: '/sys', type: 'sysfs', source: 'sysfs', options: ['nosuid', 'noexec', 'nodev', 'ro'] },
            ...mounts.map((mount) => ({ ...mount, type: 'bind', options: ['rbind', 'ro'] })),
        ],
        linux: { namespaces: ['pid', 'network', 'ipc', 'uts', 'mount'].map((type) => ({ type })) },
    };
    writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config, null, 2));
    return directory;
}

async function prepareRootfs(signal: AbortSignal) {
    mkdirSync(workDir, { recursive: true });
    const layers = await pullRootfs(image, rootfs, signal);
    mkdirSync(path.join(rootfs, path.dirname(stubPath)), { recursive: true });
    writeFileSync(path.join(rootfs, stubPath), stubSource);
    return layers;
}

class GvisorSandbox implements RunningSandbox {
    constructor(readonly id: string, readonly bundleDir: string) {}

    private options(signal: AbortSignal): RunscOptions {
        return { root, signal };
    }

    async readFile(file: string, signal: AbortSignal): Promise<string> {
        return runscOk(['exec', this.id, 'cat', file], this.options(signal));
    }

    async writeFile(file: string, content: string, signal: AbortSignal): Promise<void> {
        // Write to a temporary name and rename, so the stub never reads half a file.
        await runscOk(['exec', this.id, 'sh', '-c', `cat > '${file}.tmp' && mv '${file}.tmp' '${file}'`], { ...this.options(signal), input: content });
    }

    async isAlive(pid: number, signal: AbortSignal): Promise<boolean> {
        const result = await runsc(['exec', this.id, 'sh', '-c', `kill -0 ${String(pid)}`], this.options(signal));
        return result.code === 0;
    }

    async destroy(signal: AbortSignal): Promise<void> {
        await runsc(['kill', this.id, 'KILL'], this.options(signal));
        await runsc(['delete', '--force', this.id], this.options(signal));
    }
}

const Paused = z.object({ id: z.string(), imagePath: z.string(), bundleDir: z.string() });
type Paused = z.infer<typeof Paused>;

function runscVersion(): string {
    const [program = 'runsc', ...prefix] = (process.env.RUNSC ?? 'runsc').split(' ').filter(Boolean);
    // The terminal's stdin, so `sudo` can ask for the password once here; the later runsc calls have
    // no terminal and rely on sudo's cached credentials.
    return execFileSync(program, [...prefix, '--version'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).split('\n')[0] ?? 'unknown';
}

/** gVisor's processes on this machine: the sentry (`runsc-sandbox`) and the gofer. */
function hostUsage(): HostUsage {
    const lines = execFileSync('ps', ['-eo', 'rss=,args='], { encoding: 'utf8' }).split('\n')
        .filter((line) => line.includes('runsc-sandbox') || line.includes('runsc-gofer'));
    const rssKb = lines.reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0]), 0);
    return { processes: lines.length, rssMb: Math.round(rssKb / 1024) };
}

function directoryBytes(directory: string): number {
    const [bytes] = execFileSync('du', ['-sb', directory], { encoding: 'utf8' }).split('\t');
    return Number(bytes);
}

const backend: Backend<GvisorSandbox, Paused> = {
    name: `gVisor (${runscVersion()}, platform ${process.env.POC_RUNSC_PLATFORM ?? 'default'})`,
    paused: Paused,

    async start(signal) {
        const layers = await prepareRootfs(signal);
        const id = `poc-${String(Date.now())}`;
        // The stub isn't the container's init: when it finishes, init must stay, or the container
        // stops before the host has read done.json.
        const bundleDir = bundle(id, ['sh', '-c', `node ${stubPath}; exec sleep infinity`], stubEnv, []);
        await runscOk(['run', '--detach', `--bundle=${bundleDir}`, id], { root, signal, logFile: path.join(workDir, `${id}.log`) });
        return { sandbox: new GvisorSandbox(id, bundleDir), details: { image, layers, id } };
    },

    async pause(sandbox, signal) {
        const imagePath = path.join(workDir, 'checkpoints', sandbox.id);
        rmSync(imagePath, { recursive: true, force: true });
        mkdirSync(imagePath, { recursive: true });
        // Ends the sandbox once the image is written: nothing of it keeps running on the host.
        await runscOk(['checkpoint', `--image-path=${imagePath}`, sandbox.id], { root, signal });
        await runsc(['delete', '--force', sandbox.id], { root, signal });
        return {
            paused: { id: sandbox.id, imagePath, bundleDir: sandbox.bundleDir },
            details: { imagePath, snapshotBytes: directoryBytes(imagePath) },
        };
    },

    async resume(paused, signal) {
        // A restore always goes into a new container; the bundle must be the one it was created from.
        const id = `${paused.id}-restored-${String(Date.now())}`;
        await runscOk(['restore', '--detach', `--image-path=${paused.imagePath}`, `--bundle=${paused.bundleDir}`, id],
            { root, signal, logFile: path.join(workDir, `${id}.log`) });
        return new GvisorSandbox(id, paused.bundleDir);
    },

    hostUsage,

    async egress(allowed, denied, signal) {
        await prepareRootfs(signal);
        const gatewayDir = path.join(workDir, 'gateway');
        mkdirSync(gatewayDir, { recursive: true });
        const socket = path.join(gatewayDir, 'gateway.sock');
        const gateway = await startGateway(socket, [allowed]);
        try {
            const env: Record<string, string> = { GATEWAY_SOCKET: '/run/gateway/gateway.sock' };
            const mounts: Mount[] = [{ destination: '/run/gateway', source: gatewayDir }];
            // For a TLS-intercepting proxy between the host and the internet: trust its CA in the sandbox.
            const ca = process.env.POC_SANDBOX_CA;
            if (ca) {
                mounts.push({ destination: '/run/poc-ca.crt', source: ca });
                env.NODE_EXTRA_CA_CERTS = '/run/poc-ca.crt';
            }
            const id = `poc-egress-${String(Date.now())}`;
            const bundleDir = bundle(id, ['node', '-e', probeScript, allowed, denied], env, mounts);
            const output = await runscOk(['--host-uds=open', 'run', `--bundle=${bundleDir}`, id], { root, signal });
            await runsc(['delete', '--force', id], { root, signal });
            const result = z.record(z.string(), z.string()).parse(JSON.parse(output.trim().split('\n').at(-1) ?? '{}'));
            console.log(`     gateway: ${gateway.log.join(', ')}; direct request without the gateway → ${result.direct ?? '?'}`);
            return { allowed: result[allowed] ?? '000', denied: result[denied] ?? '000' };
        } finally {
            await gateway.stop();
        }
    },
};

await main(backend, pocDir, process.argv[2] ?? 'run');
