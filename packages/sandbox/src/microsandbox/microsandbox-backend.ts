import { Sandbox as MicrosandboxSdkSandbox, Snapshot, type SandboxHandle } from 'microsandbox';
import { abortable } from '../abortable.ts';
import { BackendLifetime } from '../backend-lifetime.ts';
import { assertPausedBy, type PausedSandbox } from '../paused-sandbox.ts';
import type { HeldSandbox, SandboxBackend } from '../sandbox-backend.ts';
import { assertSandboxId, isSandboxId, newSandboxId } from '../sandbox-id.ts';
import type { Sandbox } from '../sandbox.ts';
import type { SandboxSpec } from '../sandbox-spec.ts';
import { MicrosandboxSandbox, removeSandbox } from './microsandbox-sandbox.ts';
import { needsTlsInterception, networkPolicy, type NetworkBuilder } from './network-policy.ts';
import { sandboxIdOfSnapshot } from './snapshot-name.ts';

/**
 * The local backend with a hypervisor: microVMs through the `microsandbox` npm package, with no
 * daemon. VMs and snapshots live under `~/.microsandbox`.
 *
 * Egress to allowed hosts goes through microsandbox's TLS-intercepting proxy, see
 * {@link needsTlsInterception}.
 */
export function microsandboxBackend(): SandboxBackend {
    const lifetime = new BackendLifetime();

    return {
        name: 'microsandbox',

        async create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
            const id = newSandboxId();
            const builder = MicrosandboxSdkSandbox.builder(id)
                .image(spec.image)
                .cpus(spec.cpus)
                .memory(spec.memoryMb)
                .envs({ ...spec.env })
                .network((network: NetworkBuilder) => network.policy(networkPolicy(spec.egress)));
            const created = needsTlsInterception(spec.egress) ? builder.interceptTls().create() : builder.create();
            const sandbox = await abortable(created, lifetime.signal(signal), removeSandbox);
            return new MicrosandboxSandbox(sandbox, spec, lifetime);
        },

        async resume(paused: PausedSandbox, signal: AbortSignal): Promise<Sandbox> {
            assertPausedBy(paused, 'microsandbox');
            if (paused.snapshot === undefined) throw new Error(`The paused sandbox ${paused.id} names no snapshot.`);
            // A full restore needs the CPU and memory settings of the capture.
            const restored = MicrosandboxSdkSandbox.restore(paused.snapshot)
                .name(paused.id)
                .cpus(paused.spec.cpus)
                .memory(paused.spec.memoryMb)
                .restore();
            const sandbox = await abortable(restored, lifetime.signal(signal), removeSandbox);
            return new MicrosandboxSandbox(sandbox, paused.spec, lifetime);
        },

        async list(signal: AbortSignal): Promise<HeldSandbox[]> {
            const combined = lifetime.signal(signal);
            const running = (await abortable(allSandboxes(), combined)).filter((handle) => isSandboxId(handle.name));
            const held = new Map<string, HeldSandbox>(running.map((handle) => [handle.name, { id: handle.name, state: 'running' }]));
            for (const snapshot of await abortable(Snapshot.list(), combined)) {
                const id = sandboxIdOfSnapshot(snapshot.name);
                if (id !== undefined && !held.has(id)) held.set(id, { id, state: 'paused' });
            }
            return [...held.values()];
        },

        async remove(id: string, signal: AbortSignal): Promise<void> {
            assertSandboxId(id);
            await abortable(removeEverything(id), lifetime.signal(signal));
        },

        close: (signal: AbortSignal) => lifetime.close(signal),
    };
}

async function allSandboxes(): Promise<SandboxHandle[]> {
    const handles: SandboxHandle[] = [];
    let cursor: string | undefined;
    do {
        const page = await MicrosandboxSdkSandbox.listWith((list) => (cursor === undefined ? list : list.cursor(cursor)));
        handles.push(...page.sandboxes);
        cursor = page.nextCursor;
    } while (cursor !== undefined);
    return handles;
}

/** The VM, if there is one, and every snapshot of it. */
async function removeEverything(id: string): Promise<void> {
    const handle = (await allSandboxes()).find((candidate) => candidate.name === id);
    if (handle) {
        if (handle.status !== 'stopped' && handle.status !== 'crashed') await handle.kill();
        await handle.remove();
    }
    for (const snapshot of await Snapshot.list()) {
        if (snapshot.name !== null && sandboxIdOfSnapshot(snapshot.name) === id) await Snapshot.remove(snapshot.name, { force: true });
    }
}
