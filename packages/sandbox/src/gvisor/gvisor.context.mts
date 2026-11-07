import type { BackendLifetime } from '../backend-lifetime.mts'
import type { EgressProxies } from './egress-proxies.mts'
import type { Layout } from './layout.mts'
import type { RunscConfig } from './runsc.mts'

/** What a gVisor sandbox needs from the backend that made it. */
export interface GvisorContext {
	readonly runsc: RunscConfig
	readonly layout: Layout
	readonly lifetime: BackendLifetime
	readonly proxies: EgressProxies
	/** Kills and deletes the container, and removes everything of it on disk. */
	remove(id: string, signal: AbortSignal): Promise<void>
}
