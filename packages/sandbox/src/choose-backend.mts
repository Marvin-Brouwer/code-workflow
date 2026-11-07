import { detectHost, type Host } from './host.mts'
import type { BackendName } from './backend-name.mts'

/** The backend for this machine, and why. */
export interface BackendChoice {
	readonly backend: BackendName
	/** Why, in words, for the engine's startup log. */
	readonly reason: string
	/** Something the engine should log as a warning, such as a platform nobody has tested. */
	readonly warning?: string
}

export interface ChooseBackendOptions {
	/** Hosted runs use E2B. */
	readonly hosted: boolean
	/** A backend named in the host configuration wins over everything else. */
	readonly backend?: BackendName
}

/**
 * Picks the backend for this machine. Hosted runs use E2B. Locally it's microsandbox when a
 * hypervisor is usable and gVisor on Linux without one.
 *
 * | Host | Backend |
 * |---|---|
 * | `backend` set | that one |
 * | hosted | E2B |
 * | macOS on Apple Silicon | microsandbox (Hypervisor.framework), with a warning: untested |
 * | Windows | microsandbox (Windows Hypervisor Platform; gVisor has no Windows build) |
 * | Linux with a usable `/dev/kvm` | microsandbox |
 * | Linux without | gVisor |
 *
 * Throws on an Intel Mac and on any other platform, saying why.
 *
 * @example
 * ```ts
 * const choice = chooseBackend({ hosted: false })
 * console.log(`sandbox backend: ${choice.backend} (${choice.reason})`)
 * ```
 */
export function chooseBackend(options: ChooseBackendOptions, host: Host = detectHost()): BackendChoice {
	if (options.backend) return { backend: options.backend, reason: 'set in the host configuration' }
	if (options.hosted) return { backend: 'e2b', reason: 'hosted runs use E2B' }
	if (host.platform === 'darwin') {
		if (host.arch !== 'arm64') {
			throw new Error('No local sandbox backend runs on an Intel Mac: microsandbox only ships for Apple Silicon, gVisor needs Linux.')
		}
		return {
			backend: 'microsandbox',
			reason: 'macOS has Hypervisor.framework',
			warning: 'microsandbox on macOS is untested: CI and the conformance suite only run on Linux and Windows.',
		}
	}
	if (host.platform === 'win32') {
		return { backend: 'microsandbox', reason: "Windows has the Windows Hypervisor Platform, and gVisor doesn't run on Windows" }
	}
	if (host.platform === 'linux') {
		return host.kvm.usable
			? { backend: 'microsandbox', reason: '/dev/kvm is readable and writable' }
			: { backend: 'gvisor', reason: `${host.kvm.reason}, so no hypervisor` }
	}
	throw new Error(`No sandbox backend runs on ${host.platform}: microsandbox needs macOS, Windows or Linux, gVisor needs Linux.`)
}
