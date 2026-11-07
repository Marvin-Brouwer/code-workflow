import { abortable } from '../abortable.mts'
import { allowsEgress, type EgressPolicy } from '../sandbox-spec.mts'
import { startEgressProxy, type EgressProxy } from './egress-proxy.mts'
import type { Layout } from './layout.mts'

/** The egress proxy of every running sandbox that may reach a host. */
export class EgressProxies {
	readonly #layout: Layout
	readonly #upstreamProxy: string | undefined
	readonly #proxies = new Map<string, EgressProxy>()

	constructor(layout: Layout, upstreamProxy: string | undefined) {
		this.#layout = layout
		this.#upstreamProxy = upstreamProxy
	}

	/** Starts the sandbox's proxy, replacing one it may still have. Does nothing without egress. */
	async start(id: string, egress: EgressPolicy, signal: AbortSignal): Promise<void> {
		await this.stop(id, signal)
		if (!allowsEgress(egress)) return
		const proxy = await startEgressProxy({
			socketPath: this.#layout.sandbox(id).egressSocket,
			allow: egress.allow,
			...(this.#upstreamProxy === undefined ? {} : { upstreamProxy: this.#upstreamProxy }),
			signal,
		})
		this.#proxies.set(id, proxy)
	}

	/** Stops the sandbox's proxy, if it has one. */
	async stop(id: string, signal: AbortSignal): Promise<void> {
		const proxy = this.#proxies.get(id)
		this.#proxies.delete(id)
		if (proxy !== undefined) await abortable(proxy.close(), signal)
	}

	/** On close: stops every proxy, also of sandboxes whose removal failed. */
	async stopAll(signal: AbortSignal): Promise<void> {
		await Promise.allSettled([...this.#proxies.keys()].map((id) => this.stop(id, signal)))
	}
}
