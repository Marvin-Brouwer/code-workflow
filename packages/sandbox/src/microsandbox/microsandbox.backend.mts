import { Sandbox as MicrosandboxSdkSandbox } from 'microsandbox'
import { abortable } from '../abortable.mts'
import { assertPausedBy } from '../backend-mismatch-error.mts'
import { BackendLifetime } from '../backend-lifetime.mts'
import { PausedSandbox } from '../paused-sandbox.mts'
import type { HeldSandbox, SandboxBackend } from '../sandbox-backend.mts'
import { assertSandboxId, isSandboxId, newSandboxId } from '../sandbox-id.mts'
import type { Sandbox } from '../sandbox.mts'
import { SandboxSpec } from '../sandbox-spec.mts'
import { MicrosandboxSandbox } from './microsandbox.sandbox.mts'
import { needsTlsInterception, networkPolicy, type NetworkBuilder } from './network-policy.mts'
import { ownedSnapshots } from './snapshots.mts'
import { allSandboxes, removeSandbox, removeSandboxAndSnapshots } from './vms.mts'

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
	async function start(starting: Promise<MicrosandboxSdkSandbox>, spec: SandboxSpec, bound: AbortSignal): Promise<Sandbox> {
		const discard = (late: MicrosandboxSdkSandbox) => lifetime.keep(removeSandbox(late))
		const sandbox = await abortable(lifetime.keep(starting), bound, discard)
		return new MicrosandboxSandbox(sandbox, spec, lifetime)
	}

	return {
		name: 'microsandbox',

		async create(input: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
			// Before the SDK call: once that starts, a VM can come of it.
			const bound = lifetime.bind(signal)
			const spec = SandboxSpec.parse(input)
			const builder = MicrosandboxSdkSandbox.builder(newSandboxId())
				.image(spec.image)
				.cpus(spec.cpus)
				.memory(spec.memoryMb)
				.envs({ ...spec.env })
				.network((network: NetworkBuilder) => network.policy(networkPolicy(spec.egress)))
			const creating = needsTlsInterception(spec.egress) ? builder.interceptTls().create() : builder.create()
			return await start(creating, spec, bound)
		},

		async resume(input: PausedSandbox, signal: AbortSignal): Promise<Sandbox> {
			const paused = PausedSandbox.parse(input)
			assertPausedBy(paused, 'microsandbox')
			const { snapshot } = paused
			if (snapshot === undefined) throw new Error(`The paused sandbox ${paused.id} names no snapshot.`)
			const bound = lifetime.bind(signal)
			return await lifetime.startOnce(paused.id, () => {
				// A full restore needs the CPU and memory settings of the capture.
				const restoring = MicrosandboxSdkSandbox.restore(snapshot)
					.name(paused.id)
					.cpus(paused.spec.cpus)
					.memory(paused.spec.memoryMb)
					.restore()
				return start(restoring, paused.spec, bound)
			})
		},

		async list(signal: AbortSignal): Promise<HeldSandbox[]> {
			const bound = lifetime.bind(signal)
			const running = (await abortable(allSandboxes(), bound)).filter((handle) => isSandboxId(handle.name))
			const held = new Map<string, HeldSandbox>(running.map((handle) => [handle.name, { id: handle.name, state: 'running' }]))
			for (const { id } of await abortable(ownedSnapshots(), bound)) {
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
