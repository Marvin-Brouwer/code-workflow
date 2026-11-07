import { ALL_TRAFFIC, Sandbox as E2bSdkSandbox, type SandboxOpts } from 'e2b'
import { assertPausedBy } from '../backend-mismatch-error.mts'
import { BackendLifetime } from '../backend-lifetime.mts'
import { PausedSandbox } from '../paused-sandbox.mts'
import type { HeldSandbox, SandboxBackend } from '../sandbox-backend.mts'
import type { Sandbox } from '../sandbox.mts'
import { allowsEgress, type EgressPolicy, SandboxSpec } from '../sandbox-spec.mts'
import { E2bSandbox } from './e2b.sandbox.mts'

/** Metadata on every sandbox this package creates, so `list` finds only those. */
const ownerMetadata = { 'mesh-flow': 'true' }
const defaultTimeoutMs = 24 * 60 * 60 * 1000

export interface E2bBackendOptions {
	/** Comes from the engine's credential store. It stays on the host. */
	readonly apiKey: string
	/** The domain of a self-hosted E2B deployment. Leave it out for E2B Cloud. */
	readonly domain?: string
	/**
	 * The E2B template to use for each image a spec can name. E2B builds sandboxes from templates,
	 * not from images, and a template fixes CPUs and memory: `cpus` and `memoryMb` in the spec
	 * aren't used here.
	 */
	readonly templates: Readonly<Record<string, string>>
	/**
	 * How long a sandbox may run before E2B pauses it on its own (memory included). That is the
	 * limit for a sandbox an engine left behind when it died. Default 24 hours.
	 */
	readonly timeoutMs?: number
}

/**
 * The hosted backend: sandboxes on E2B, paused with memory and processes.
 *
 * Mind that E2B stops the guest's monotonic clock while paused: a `setTimeout` inside the
 * sandbox doesn't count paused time. Wall-clock waits belong in the engine.
 *
 * A create that is aborted after E2B received it can still make a sandbox this process never
 * hears of. It carries the mesh-flow metadata, so `list` finds it and reconciliation removes it.
 */
export function e2bBackend(options: E2bBackendOptions): SandboxBackend {
	const lifetime = new BackendLifetime()
	const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
	const connection = { apiKey: options.apiKey, ...(options.domain === undefined ? {} : { domain: options.domain }) }

	return {
		name: 'e2b',

		async create(input: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
			const spec = SandboxSpec.parse(input)
			const template = options.templates[spec.image]
			if (template === undefined) throw new Error(`No E2B template is configured for the image '${spec.image}'.`)
			const sandbox = await E2bSdkSandbox.create(template, {
				...connection,
				metadata: ownerMetadata,
				envs: { ...spec.env },
				timeoutMs,
				lifecycle: { onTimeout: 'pause' },
				...networkOptions(spec.egress),
				signal: lifetime.bind(signal),
			})
			return new E2bSandbox(sandbox, spec, lifetime)
		},

		async resume(input: PausedSandbox, signal: AbortSignal): Promise<Sandbox> {
			const paused = PausedSandbox.parse(input)
			assertPausedBy(paused, 'e2b')
			const bound = lifetime.bind(signal)
			return lifetime.startOnce(paused.id, async () => {
				const sandbox = await E2bSdkSandbox.connect(paused.id, { ...connection, timeoutMs, signal: bound })
				return new E2bSandbox(sandbox, paused.spec, lifetime)
			})
		},

		async list(signal: AbortSignal): Promise<HeldSandbox[]> {
			const bound = lifetime.bind(signal)
			const paginator = E2bSdkSandbox.list({ ...connection, query: { metadata: ownerMetadata } })
			const held: HeldSandbox[] = []
			while (paginator.hasNext) {
				for (const info of await paginator.nextItems({ signal: bound })) held.push({ id: info.sandboxId, state: info.state })
			}
			return held
		},

		async remove(id: string, signal: AbortSignal): Promise<void> {
			// Returns false when the sandbox is already gone, which is fine here.
			await E2bSdkSandbox.kill(id, { ...connection, signal: lifetime.bind(signal) })
			lifetime.untrack(id)
		},

		close: (signal: AbortSignal) => lifetime.close(signal),
	}
}

/**
 * Deny everything but the allowed hosts. E2B also lets the sandbox reach its DNS servers whenever
 * a host is allowed, see the README's known gaps.
 */
function networkOptions(egress: EgressPolicy): Pick<SandboxOpts, 'allowInternetAccess' | 'network'> {
	if (!allowsEgress(egress)) return { allowInternetAccess: false }
	return { network: { allowOut: [...egress.allow], denyOut: [ALL_TRAFFIC] } }
}
