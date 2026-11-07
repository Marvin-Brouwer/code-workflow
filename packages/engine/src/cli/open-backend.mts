import path from 'node:path'
import { chooseBackend, type BackendName, type SandboxBackend } from '@mesh-flow/sandbox'

export interface OpenBackendOptions {
	readonly home: string
	/** A backend named on the command line wins over the machine's own choice. */
	readonly backend?: BackendName
	/** How to call runsc, for gVisor, such as `['sudo', '/usr/bin/runsc']`. */
	readonly runsc?: readonly string[]
	readonly log: (message: string) => void
}

/** Picks this machine's sandbox backend and loads only that one's SDK. */
export async function openBackend(options: OpenBackendOptions): Promise<SandboxBackend> {
	const choice = chooseBackend({ hosted: false, ...(options.backend ? { backend: options.backend } : {}) })
	options.log(`Sandbox backend: ${choice.backend} (${choice.reason}).`)
	if (choice.warning) options.log(`Warning: ${choice.warning}`)
	if (choice.backend === 'gvisor') {
		const { gvisorBackend } = await import('@mesh-flow/sandbox/gvisor')
		return gvisorBackend({ directory: path.join(options.home, 'gvisor'), ...(options.runsc ? { runsc: options.runsc } : {}) })
	}
	if (choice.backend === 'microsandbox') {
		const { microsandboxBackend } = await import('@mesh-flow/sandbox/microsandbox')
		return microsandboxBackend()
	}
	throw new Error(
		"E2B needs an API key from the engine's credential store, which comes with the gateway. Use microsandbox or gVisor for now.",
	)
}
