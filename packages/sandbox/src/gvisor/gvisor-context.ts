import type { BackendLifetime } from '../backend-lifetime.ts';
import type { Layout } from './layout.ts';
import type { Runsc } from './runsc.ts';

/** What a gVisor sandbox needs from the backend that made it. */
export interface GvisorContext {
    readonly runsc: Runsc;
    readonly layout: Layout;
    readonly lifetime: BackendLifetime;
    /** Stops the sandbox's egress proxy, if it has one. */
    stopEgress(id: string): Promise<void>;
    /** Kills and deletes the container, and removes everything of it on disk. */
    remove(id: string, signal: AbortSignal): Promise<void>;
}
