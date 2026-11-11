import { messageOf } from '../errors.mts'
import type { PowerApi } from './windows-power.mts'

/** What `powercfg /requests` shows for the engine's power request. */
export const powerRequestReason = 'mesh-flow serve: workflow runs wait on the network'

/** What `keepAwake` takes. */
export interface KeepAwakeOptions {
	/** Gives the power request back when it aborts: the engine is shutting down. */
	readonly abortSignal: AbortSignal
	/** Where a warning goes when Windows says no. */
	readonly log: (message: string) => void
	/** Default: this process's platform. */
	readonly platform?: NodeJS.Platform
	/** Loads the Windows power calls. Default: kernel32, loaded only on Windows. */
	readonly loadPowerApi?: () => Promise<PowerApi>
}

/**
 * On Windows, keeps the engine going while the PC is locked: it holds a power request, so the
 * machine doesn't idle-sleep and drop the network, and the process isn't suspended in Modern
 * Standby, and it opts out of power throttling, which would slow its timers down in the
 * background. Runs that wait for hours on GitHub otherwise lose their connections. Explicitly
 * putting the machine to sleep or closing the lid still works.
 *
 * Elsewhere it does nothing. It never fails the engine: when Windows says no, it logs a warning.
 */
export async function keepAwake(options: KeepAwakeOptions): Promise<void> {
	if ((options.platform ?? process.platform) !== 'win32') return
	const loadPowerApi = options.loadPowerApi ?? loadWindowsPowerApi
	let api: PowerApi
	try {
		api = await loadPowerApi()
	} catch (error) {
		options.log(`Warning: can't keep Windows awake while the PC is locked: ${messageOf(error)}`)
		return
	}
	// Loading kernel32 takes a moment, and the engine may have started shutting down meanwhile.
	if (options.abortSignal.aborted) return
	try {
		const release = api.holdPowerRequest(powerRequestReason)
		options.abortSignal.addEventListener('abort', release, { once: true })
	} catch (error) {
		options.log(`Warning: Windows may sleep while the PC is locked, which drops the network for running workflows: ${messageOf(error)}`)
	}
	try {
		api.optOutOfThrottling()
	} catch (error) {
		options.log(`Warning: Windows may throttle the engine in the background: ${messageOf(error)}`)
	}
}

async function loadWindowsPowerApi(): Promise<PowerApi> {
	const { windowsPowerApi } = await import('./windows-power.mts')
	return windowsPowerApi()
}
