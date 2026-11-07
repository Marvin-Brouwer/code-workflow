import { ALL_TRAFFIC, Sandbox as E2bSdkSandbox, type SandboxOpts } from 'e2b';
import { BackendLifetime } from '../backend-lifetime.ts';
import { assertPausedBy, type PausedSandbox } from '../paused-sandbox.ts';
import type { HeldSandbox, SandboxBackend } from '../sandbox-backend.ts';
import type { Sandbox } from '../sandbox.ts';
import type { EgressPolicy, SandboxSpec } from '../sandbox-spec.ts';
import { E2bSandbox } from './e2b-sandbox.ts';

/** Metadata on every sandbox this package creates, so `list` finds only those. */
const ownerKey = 'mesh-flow';

export interface E2bBackendOptions {
    /** Comes from the engine's credential store. It stays on the host. */
    readonly apiKey: string;
    /**
     * The E2B template to use for each image a spec can name. E2B builds sandboxes from templates,
     * not from images, and a template fixes CPUs and memory: `cpus` and `memoryMb` in the spec
     * aren't used here.
     */
    readonly templates: Readonly<Record<string, string>>;
    /**
     * How long a sandbox may run before E2B pauses it on its own (memory included). That is the
     * limit for a sandbox an engine left behind when it died. Default 24 hours.
     */
    readonly timeoutMs?: number;
}

/**
 * The hosted backend: sandboxes on E2B Cloud, paused with memory and processes.
 *
 * Mind that E2B stops the guest's monotonic clock while paused: a `setTimeout` inside the
 * sandbox doesn't count paused time. Wall-clock waits belong in the engine.
 */
export function e2bBackend(options: E2bBackendOptions): SandboxBackend {
    const lifetime = new BackendLifetime();
    const timeoutMs = options.timeoutMs ?? 24 * 60 * 60 * 1000;
    const connection = { apiKey: options.apiKey };

    return {
        name: 'e2b',

        async create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
            const template = options.templates[spec.image];
            if (template === undefined) throw new Error(`No E2B template is configured for the image '${spec.image}'.`);
            const sandbox = await E2bSdkSandbox.create(template, {
                ...connection,
                metadata: { [ownerKey]: 'true' },
                envs: { ...spec.env },
                timeoutMs,
                lifecycle: { onTimeout: 'pause' },
                ...network(spec.egress),
                signal: lifetime.signal(signal),
            });
            return new E2bSandbox(sandbox, spec, lifetime);
        },

        async resume(paused: PausedSandbox, signal: AbortSignal): Promise<Sandbox> {
            assertPausedBy(paused, 'e2b');
            const sandbox = await E2bSdkSandbox.connect(paused.id, { ...connection, timeoutMs, signal: lifetime.signal(signal) });
            return new E2bSandbox(sandbox, paused.spec, lifetime);
        },

        async list(signal: AbortSignal): Promise<HeldSandbox[]> {
            const combined = lifetime.signal(signal);
            const paginator = E2bSdkSandbox.list({ ...connection, query: { metadata: { [ownerKey]: 'true' } } });
            const held: HeldSandbox[] = [];
            while (paginator.hasNext) {
                for (const info of await paginator.nextItems({ signal: combined })) held.push({ id: info.sandboxId, state: info.state });
            }
            return held;
        },

        async remove(id: string, signal: AbortSignal): Promise<void> {
            // Returns false when the sandbox is already gone, which is fine here.
            await E2bSdkSandbox.kill(id, { ...connection, signal: lifetime.signal(signal) });
        },

        close: (signal: AbortSignal) => lifetime.close(signal),
    };
}

function network(egress: EgressPolicy): Pick<SandboxOpts, 'allowInternetAccess' | 'network'> {
    if (egress.allow.length === 0) return { allowInternetAccess: false };
    return { network: { allowOut: [...egress.allow], denyOut: [ALL_TRAFFIC] } };
}
