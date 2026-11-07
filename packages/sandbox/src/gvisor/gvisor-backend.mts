import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { abortable } from '../abortable.mts'
import { BackendLifetime } from '../backend-lifetime.mts'
import { assertPausedBy, type PausedSandbox } from '../paused-sandbox.mts'
import type { HeldSandbox, SandboxBackend } from '../sandbox-backend.mts'
import { assertSandboxId, isSandboxId, newSandboxId } from '../sandbox-id.mts'
import type { Sandbox } from '../sandbox.mts'
import type { SandboxSpec } from '../sandbox-spec.mts'
import { writeBundle } from './bundle.mts'
import { forwarderEnv, forwarderInit } from './egress-forwarder.mts'
import { startEgressProxy, type EgressProxy } from './egress-proxy.mts'
import type { GvisorContext } from './gvisor-context.mts'
import { GvisorSandbox } from './gvisor-sandbox.mts'
import { egressMountPoint, Layout } from './layout.mts'
import { prepareRootfs } from './rootfs.mts'
import { runsc, runscOk, type Runsc } from './runsc.mts'

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
const checkpointName = /^[0-9a-z]+$/

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
	const config: Runsc = {
		command: options.runsc ?? ['runsc'],
		root: layout.runscRoot,
		...(options.platform === undefined ? {} : { platform: options.platform }),
	}
	const proxies = new Map<string, EgressProxy>()
	const pulls = new Map<string, Promise<string>>()

	/** One pull per image at a time, shared by every caller and stopped only by close. */
	function rootfs(image: string, signal: AbortSignal): Promise<string> {
		let pull = pulls.get(image)
		if (pull === undefined) {
			pull = prepareRootfs(layout.images, image, lifetime.closing)
			pulls.set(image, pull)
			pull.catch(() => pulls.delete(image))
		}
		return abortable(pull, signal)
	}

	async function startEgress(id: string, spec: SandboxSpec): Promise<void> {
		if (spec.egress.allow.length === 0) return
		const proxy = await startEgressProxy({
			socketPath: layout.sandbox(id).egressSocket,
			allow: spec.egress.allow,
			...(options.upstreamProxy === undefined ? {} : { upstreamProxy: options.upstreamProxy }),
		})
		proxies.set(id, proxy)
	}

	async function stopEgress(id: string): Promise<void> {
		await proxies.get(id)?.close()
		proxies.delete(id)
	}

	async function remove(id: string, signal: AbortSignal): Promise<void> {
		// Either may fail because the container is already gone; the directory is what's left then.
		await runsc(config, ['kill', id, 'KILL'], { signal })
		await runsc(config, ['delete', '--force', id], { signal })
		await stopEgress(id)
		await rm(layout.sandbox(id).directory, { recursive: true, force: true })
	}

	const context: GvisorContext = { runsc: config, layout, lifetime, stopEgress, remove }

	return {
		name: 'gvisor',

		async create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
			const combined = lifetime.signal(signal)
			const id = newSandboxId()
			const paths = layout.sandbox(id)
			const egress = spec.egress.allow.length > 0
			const root = await rootfs(spec.image, combined)
			try {
				await mkdir(paths.egress, { recursive: true })
				await writeBundle(paths.bundle, {
					rootfs: root,
					init: egress ? forwarderInit : ['sleep', 'infinity'],
					env: { ...spec.env, ...(egress ? forwarderEnv : {}) },
					cpus: spec.cpus,
					memoryMb: spec.memoryMb,
					mounts: egress ? [{ source: paths.egress, destination: egressMountPoint }] : [],
				})
				await startEgress(id, spec)
				await runscOk(config, ['run', '--detach', `--bundle=${paths.bundle}`, id], { signal: combined, logFile: paths.log })
			} catch (error) {
				await remove(id, AbortSignal.timeout(10_000)).catch(() => undefined)
				throw error
			}
			return new GvisorSandbox(id, spec, context)
		},

		async resume(paused: PausedSandbox, signal: AbortSignal): Promise<Sandbox> {
			assertPausedBy(paused, 'gvisor')
			assertSandboxId(paused.id)
			if (paused.snapshot === undefined || !checkpointName.test(paused.snapshot)) {
				throw new Error(`The paused sandbox ${paused.id} names no valid checkpoint.`)
			}
			const combined = lifetime.signal(signal)
			const paths = layout.sandbox(paused.id)
			const imagePath = path.join(paths.checkpoints, paused.snapshot)
			if (!existsSync(imagePath)) throw new Error(`The checkpoint of ${paused.id} is gone: ${imagePath}`)
			try {
				// A pause that couldn't delete its container leaves the record behind.
				await runsc(config, ['delete', '--force', paused.id], { signal: combined })
				await startEgress(paused.id, paused.spec)
				// The bundle must be the one the sandbox was created from.
				await runscOk(config, ['restore', '--detach', `--image-path=${imagePath}`, `--bundle=${paths.bundle}`, paused.id], {
					signal: combined,
					logFile: paths.log,
				})
			} catch (error) {
				await stopEgress(paused.id)
				throw error
			}
			return new GvisorSandbox(paused.id, paused.spec, context)
		},

		async list(signal: AbortSignal): Promise<HeldSandbox[]> {
			const combined = lifetime.signal(signal)
			const listed = RunscList.parse(JSON.parse((await runscOk(config, ['list', '--format=json'], { signal: combined })) || 'null'))
			const held = new Map<string, HeldSandbox>()
			for (const container of listed ?? []) {
				if (isSandboxId(container.id)) held.set(container.id, { id: container.id, state: 'running' })
			}
			const directories = existsSync(layout.sandboxes) ? await readdir(layout.sandboxes) : []
			for (const id of directories.filter(isSandboxId)) {
				// A directory without a finished checkpoint belonged to a sandbox that was running.
				if (!held.has(id)) held.set(id, { id, state: (await hasCheckpoint(layout, id)) ? 'paused' : 'running' })
			}
			return [...held.values()]
		},

		async remove(id: string, signal: AbortSignal): Promise<void> {
			assertSandboxId(id)
			await remove(id, lifetime.signal(signal))
		},

		async close(signal: AbortSignal): Promise<void> {
			try {
				await lifetime.close(signal)
			} finally {
				await Promise.all([...proxies.keys()].map(stopEgress))
			}
		},
	}
}

async function hasCheckpoint(layout: Layout, id: string): Promise<boolean> {
	const { checkpoints } = layout.sandbox(id)
	if (!existsSync(checkpoints)) return false
	return (await readdir(checkpoints)).some((entry) => checkpointName.test(entry))
}
