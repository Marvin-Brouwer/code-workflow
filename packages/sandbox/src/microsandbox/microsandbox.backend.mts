import { Sandbox as MicrosandboxSdkSandbox, Snapshot, type SandboxHandle } from 'microsandbox'
import { abortable } from '../abortable.mts'
import { assertPausedBy } from '../backend-mismatch-error.mts'
import { BackendLifetime } from '../backend-lifetime.mts'
import type { PausedSandbox } from '../paused-sandbox.mts'
import type { HeldSandbox, SandboxBackend } from '../sandbox-backend.mts'
import { assertSandboxId, isSandboxId, newSandboxId } from '../sandbox-id.mts'
import type { Sandbox } from '../sandbox.mts'
import { SandboxSpec } from '../sandbox-spec.mts'
import { MicrosandboxSandbox, removeSandbox } from './microsandbox.sandbox.mts'
import { needsTlsInterception, networkPolicy, type NetworkBuilder } from './network-policy.mts'
import { meshFlowSnapshots, snapshotsOf } from './snapshots.mts'

/**
 * The local backend with a hypervisor: microVMs through the `microsandbox` npm package, with no
 * daemon. VMs and snapshots live under `~/.microsandbox`.
 *
 * Egress to allowed hosts goes through microsandbox's TLS-intercepting proxy, see
 * {@link needsTlsInterception}.
 */
export function microsandboxBackend(): SandboxBackend {
	const lifetime = new BackendLifetime()

	/**
	 * The SDK takes no signals: a create or restore keeps going after an abort. `close` waits for
	 * it, and a VM that arrives too late is removed.
	 */
	async function start(starting: Promise<MicrosandboxSdkSandbox>, spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
		const discard = (late: MicrosandboxSdkSandbox) => lifetime.keep(removeSandbox(late))
		const sandbox = await abortable(lifetime.keep(starting), lifetime.bind(signal), discard)
		return new MicrosandboxSandbox(sandbox, spec, lifetime)
	}

	return {
		name: 'microsandbox',

		async create(input: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
			const spec = SandboxSpec.parse(input)
			const builder = MicrosandboxSdkSandbox.builder(newSandboxId())
				.image(spec.image)
				.cpus(spec.cpus)
				.memory(spec.memoryMb)
				.envs({ ...spec.env })
				.network((network: NetworkBuilder) => network.policy(networkPolicy(spec.egress)))
			const creating = needsTlsInterception(spec.egress) ? builder.interceptTls().create() : builder.create()
			return await start(creating, spec, signal)
		},

		async resume(paused: PausedSandbox, signal: AbortSignal): Promise<Sandbox> {
			assertPausedBy(paused, 'microsandbox')
			if (paused.snapshot === undefined) throw new Error(`The paused sandbox ${paused.id} names no snapshot.`)
			if (lifetime.tracks(paused.id)) throw new Error(`The sandbox ${paused.id} is already running.`)
			// A full restore needs the CPU and memory settings of the capture.
			const restoring = MicrosandboxSdkSandbox.restore(paused.snapshot)
				.name(paused.id)
				.cpus(paused.spec.cpus)
				.memory(paused.spec.memoryMb)
				.restore()
			return await start(restoring, paused.spec, signal)
		},

		async list(signal: AbortSignal): Promise<HeldSandbox[]> {
			const bound = lifetime.bind(signal)
			const running = (await abortable(allSandboxes(), bound)).filter((handle) => isSandboxId(handle.name))
			const held = new Map<string, HeldSandbox>(running.map((handle) => [handle.name, { id: handle.name, state: 'running' }]))
			for (const { id } of await abortable(meshFlowSnapshots(), bound)) {
				if (!held.has(id)) held.set(id, { id, state: 'paused' })
			}
			return [...held.values()]
		},

		async remove(id: string, signal: AbortSignal): Promise<void> {
			assertSandboxId(id)
			await abortable(lifetime.keep(removeSandboxAndSnapshots(id)), lifetime.bind(signal))
			lifetime.untrack(id)
		},

		close: (signal: AbortSignal) => lifetime.close(signal),
	}
}

async function allSandboxes(): Promise<SandboxHandle[]> {
	const handles: SandboxHandle[] = []
	let cursor: string | undefined
	do {
		const page = await MicrosandboxSdkSandbox.listWith((list) => (cursor === undefined ? list : list.cursor(cursor)))
		handles.push(...page.sandboxes)
		cursor = page.nextCursor
	} while (cursor !== undefined)
	return handles
}

/** The VM, if there is one, and every snapshot of it. */
async function removeSandboxAndSnapshots(id: string): Promise<void> {
	const handle = (await allSandboxes()).find((candidate) => candidate.name === id)
	if (handle) {
		if (handle.status !== 'stopped' && handle.status !== 'crashed') await handle.kill()
		await handle.remove()
	}
	for (const snapshot of await snapshotsOf(id)) {
		if (snapshot.name !== null) await Snapshot.remove(snapshot.name, { force: true })
	}
}
