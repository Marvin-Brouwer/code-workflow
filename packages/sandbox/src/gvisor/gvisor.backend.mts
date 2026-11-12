import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { assertPausedBy } from '../backend-mismatch-error.mts'
import { BackendLifetime } from '../backend-lifetime.mts'
import { PausedSandbox } from '../paused-sandbox.mts'
import type { HeldSandbox, SandboxBackend } from '../sandbox-backend.mts'
import { assertSandboxId, isSandboxId, newSandboxId } from '../sandbox-id.mts'
import type { Sandbox } from '../sandbox.mts'
import { allowsEgress, SandboxSpec } from '../sandbox-spec.mts'
import { writeBundle } from './bundle.mts'
import { hasCheckpoint, isCheckpointName } from './checkpoint.mts'
import { forwarderEnv, forwarderReadyCheck, forwarderService } from './egress-forwarder.mts'
import { EgressProxies } from './egress-proxies.mts'
import type { GvisorContext } from './gvisor.context.mts'
import { GvisorSandbox } from './gvisor.sandbox.mts'
import { initCommand } from './init.mts'
import { egressMountPoint, Layout } from './layout.mts'
import { RootfsCache } from './rootfs.mts'
import { runsc, runscOrThrow, type RunscConfig } from './runsc.mts'

export interface GvisorBackendOptions {
	/** Where images, bundles, checkpoints and runsc's state live. Keep it across restarts. */
	readonly directory: string
	/** How to call runsc. Default `['runsc']`; `['sudo', 'runsc']` when the engine isn't root. */
	readonly runsc?: readonly string[]
	/** runsc's platform. Default `systrap`, which needs no KVM. */
	readonly platform?: string
	/** An HTTP proxy between this machine and the internet, as `http://host:port`. */
	readonly upstreamProxy?: string
}

const RunscList = z.array(z.object({ id: z.string(), status: z.string() })).nullable()

/** How long cleanup after a failed create or resume may take, once the caller has given up. */
const cleanupTimeoutMs = 10_000

/**
 * The local backend without a hypervisor: gVisor's `runsc`, Linux only, as root. No Docker: images
 * are pulled from Docker Hub and unpacked by this package.
 *
 * Sandboxes have no network (`--network=none`). When the spec allows hosts, a proxy on the host
 * tunnels to those hosts only, over a Unix socket in the sandbox, and the sandbox's init forwards
 * `HTTPS_PROXY` to it. That init needs `node` in the image, and only tools that honour
 * `HTTPS_PROXY` get out.
 *
 * Unlike E2B, timers inside the sandbox do count paused time here.
 */
export function gvisorBackend(options: GvisorBackendOptions): SandboxBackend {
	const layout = new Layout(options.directory)
	const lifetime = new BackendLifetime()
	const config: RunscConfig = {
		command: options.runsc ?? ['runsc'],
		root: layout.runscRoot,
		...(options.platform === undefined ? {} : { platform: options.platform }),
	}
	const images = new RootfsCache(layout.images, lifetime)
	const proxies = new EgressProxies(layout, options.upstreamProxy)

	/** Either runsc call may fail because the container is already gone, which is fine. */
	async function stopContainer(id: string, signal: AbortSignal): Promise<void> {
		await runsc(config, ['kill', id, 'KILL'], { signal })
		await runsc(config, ['delete', '--force', id], { signal })
		await proxies.stop(id, signal)
	}

	async function removeFromDisk(id: string, signal: AbortSignal): Promise<void> {
		await stopContainer(id, signal)
		await rm(layout.sandbox(id).directory, { recursive: true, force: true })
	}

	/** Cleanup after a failed start, which `close` waits for. */
	async function cleanUp(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
		await lifetime.keep(work(AbortSignal.timeout(cleanupTimeoutMs))).catch(() => undefined)
	}

	/** `status` is runsc's, for a container it still has a record of. */
	async function stateOf(id: string, status?: string): Promise<HeldSandbox['state']> {
		if (status === 'running') return 'running'
		// Not running, but with a finished checkpoint: a pause that couldn't delete its container.
		// Without one, it belonged to a sandbox that was running.
		return (await hasCheckpoint(layout.sandbox(id).checkpoints)) ? 'paused' : 'running'
	}

	const context: GvisorContext = { runsc: config, layout, lifetime, proxies, remove: removeFromDisk }

	return {
		name: 'gvisor',

		async create(input: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
			const spec = SandboxSpec.parse(input)
			const bound = lifetime.bind(signal)
			const id = newSandboxId()
			const paths = layout.sandbox(id)
			const egress = allowsEgress(spec.egress)
			const rootfs = await images.get(spec.image, bound)
			try {
				await mkdir(paths.egress, { recursive: true })
				await writeBundle(paths.bundle, {
					rootfs,
					init: initCommand(egress ? forwarderService : []),
					env: { ...spec.env, ...(egress ? forwarderEnv : {}) },
					cpus: spec.cpus,
					memoryMb: spec.memoryMb,
					mounts: egress ? [{ source: paths.egress, destination: egressMountPoint }] : [],
				})
				await proxies.start(id, spec.egress, bound)
				await runscOrThrow(config, ['run', '--detach', `--bundle=${paths.bundle}`, id], { signal: bound, logFile: paths.log })
				if (egress) await runscOrThrow(config, ['exec', id, ...forwarderReadyCheck], { signal: bound })
			} catch (error) {
				await cleanUp((cleanupSignal) => removeFromDisk(id, cleanupSignal))
				throw error
			}
			return new GvisorSandbox(id, spec, context)
		},

		async resume(input: PausedSandbox, signal: AbortSignal): Promise<Sandbox> {
			const paused = PausedSandbox.parse(input)
			assertPausedBy(paused, 'gvisor')
			assertSandboxId(paused.id)
			if (paused.snapshot === undefined || !isCheckpointName(paused.snapshot)) {
				throw new Error(`The paused sandbox ${paused.id} names no valid checkpoint.`)
			}
			const bound = lifetime.bind(signal)
			const paths = layout.sandbox(paused.id)
			const imagePath = path.join(paths.checkpoints, paused.snapshot)
			if (!existsSync(imagePath)) throw new Error(`The checkpoint of ${paused.id} is gone: ${imagePath}`)
			return lifetime.startOnce(paused.id, async () => {
				try {
					// A pause that couldn't delete its container leaves the record behind.
					await runsc(config, ['delete', '--force', paused.id], { signal: bound })
					await proxies.start(paused.id, paused.spec.egress, bound)
					// The bundle must be the one the sandbox was created from.
					await runscOrThrow(config, ['restore', '--detach', `--image-path=${imagePath}`, `--bundle=${paths.bundle}`, paused.id], {
						signal: bound,
						logFile: paths.log,
					})
				} catch (error) {
					// The directory stays: its checkpoint is what a retry needs.
					await cleanUp((cleanupSignal) => stopContainer(paused.id, cleanupSignal))
					throw error
				}
				return new GvisorSandbox(paused.id, paused.spec, context)
			})
		},

		async list(signal: AbortSignal): Promise<HeldSandbox[]> {
			const bound = lifetime.bind(signal)
			const output = await runscOrThrow(config, ['list', '--format=json'], { signal: bound })
			const containers = RunscList.parse(JSON.parse(output || 'null')) ?? []
			const held = new Map<string, HeldSandbox>()
			for (const container of containers.filter((candidate) => isSandboxId(candidate.id))) {
				held.set(container.id, { id: container.id, state: await stateOf(container.id, container.status) })
			}
			const directories = existsSync(layout.sandboxes) ? await readdir(layout.sandboxes) : []
			for (const id of directories.filter(isSandboxId)) {
				if (!held.has(id)) held.set(id, { id, state: await stateOf(id) })
			}
			return [...held.values()]
		},

		async remove(id: string, signal: AbortSignal): Promise<void> {
			assertSandboxId(id)
			await removeFromDisk(id, lifetime.bind(signal))
			lifetime.untrack(id)
		},

		async close(signal: AbortSignal): Promise<void> {
			try {
				await lifetime.close(signal)
			} finally {
				await proxies.stopAll(signal)
			}
		},
	}
}
