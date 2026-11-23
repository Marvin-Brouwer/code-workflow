import { Sandbox as MicrosandboxSdkSandbox } from 'microsandbox'
import { abortable } from '../abortable.mts'
import { assertPausedBy } from '../backend-mismatch-error.mts'
import { BackendLifetime } from '../backend-lifetime.mts'
import { PausedSandbox } from '../paused-sandbox.mts'
import type { HeldSandbox, SandboxBackend } from '../sandbox-backend.mts'
import { assertSandboxId, isSandboxId, newSandboxId } from '../sandbox-id.mts'
import type { Sandbox } from '../sandbox.mts'
import { SandboxSpecification } from '../sandbox-specification.mts'
import { MicrosandboxSandbox } from './microsandbox.sandbox.mts'
import { noNetwork } from './no-network.mts'
import { ownedSnapshots } from './snapshots.mts'
import { allSandboxes, removeSandbox, removeSandboxAndSnapshots } from './vms.mts'

/**
 * The local backend with a hypervisor: microVMs through the `microsandbox` npm package, with no
 * daemon. VMs and snapshots live under `~/.microsandbox`. VMs have no network, only loopback.
 */
export function microsandboxBackend(): SandboxBackend {
	const lifetime = new BackendLifetime()

	/**
	 * The SDK takes no signals: a create or restore keeps going after an abort. `close` waits for
	 * it, and a VM that arrives too late is removed.
	 */
	async function start(
		starting: Promise<MicrosandboxSdkSandbox>,
		specification: SandboxSpecification,
		bound: AbortSignal,
	): Promise<Sandbox> {
		const discard = (late: MicrosandboxSdkSandbox) => lifetime.keep(removeSandbox(late))
		const sandbox = await abortable(lifetime.keep(starting), bound, discard)
		return new MicrosandboxSandbox(sandbox, specification, lifetime)
	}

	return {
		name: 'microsandbox',

		async create(input: SandboxSpecification, signal: AbortSignal): Promise<Sandbox> {
			// Before the SDK call: once that starts, a VM can come of it.
			const bound = lifetime.bind(signal)
			const specification = SandboxSpecification.parse(input)
			const builder = MicrosandboxSdkSandbox.builder(newSandboxId())
				.image(specification.image)
				.cpus(specification.cpus)
				.memory(specification.memoryMb)
				.envs({ ...specification.environment })
				.network(noNetwork)
			return await start(builder.create(), specification, bound)
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
					.cpus(paused.specification.cpus)
					.memory(paused.specification.memoryMb)
					.restore()
				return start(restoring, paused.specification, bound)
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
