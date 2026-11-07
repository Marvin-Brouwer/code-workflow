import { detectHost, type Host } from './host.ts';
import type { BackendName } from './paused-sandbox.ts';

export interface BackendChoice {
    readonly backend: BackendName;
    /** Why, in words, for the engine's startup log. */
    readonly reason: string;
}

export interface ChooseBackendOptions {
    /** Hosted runs use E2B Cloud. */
    readonly hosted: boolean;
    /** Host configuration that names a backend wins over everything else. */
    readonly force?: BackendName;
}

/**
 * Picks the backend for this machine. Hosted runs use E2B. Locally it's microsandbox when a
 * hypervisor is usable and gVisor on Linux without one.
 *
 * | Host | Backend |
 * |---|---|
 * | `force` set | that one |
 * | hosted | E2B |
 * | macOS | microsandbox (Hypervisor.framework) |
 * | Windows | microsandbox (Windows Hypervisor Platform, untried; gVisor has no Windows build) |
 * | Linux with a usable `/dev/kvm` | microsandbox |
 * | Linux without | gVisor |
 *
 * Throws on any other platform, saying why.
 *
 * @example
 * ```ts
 * const choice = chooseBackend({ hosted: false });
 * console.log(`sandbox backend: ${choice.backend} (${choice.reason})`);
 * ```
 */
export function chooseBackend(options: ChooseBackendOptions, host: Host = detectHost()): BackendChoice {
    if (options.force) return { backend: options.force, reason: 'set in the host configuration' };
    if (options.hosted) return { backend: 'e2b', reason: 'hosted runs use E2B' };
    if (host.platform === 'darwin') return { backend: 'microsandbox', reason: 'macOS has Hypervisor.framework' };
    if (host.platform === 'win32') {
        return { backend: 'microsandbox', reason: "Windows has the Windows Hypervisor Platform, and gVisor doesn't run on Windows" };
    }
    if (host.platform === 'linux') {
        return host.kvm.usable
            ? { backend: 'microsandbox', reason: '/dev/kvm is readable and writable' }
            : { backend: 'gvisor', reason: `${host.kvm.reason}, so no hypervisor` };
    }
    throw new Error(`No sandbox backend runs on ${host.platform}: microsandbox needs macOS, Windows or Linux, gVisor needs Linux.`);
}
