import { messageOf } from '../errors.mts'
import type { PowerApi } from './windows-power.mts'

/** What `powercfg /requests` shows for the engine's power request. */
export const powerRequestReason = 'mesh-flow serve: workflow runs wait on the network'

/** What `keepAwake` takes. */
export interface KeepAwakeOptions {
	/** Stops loading the power calls when it aborts: the engine is shutting down before it got that far. */
	readonly abortSignal: AbortSignal
	/** Where a warning goes when Windows says no. */
	readonly log: (message: string) => void
	/** Default: this process's platform. */
	readonly platform?: NodeJS.Platform
	/** Loads the Windows power calls. Default: kernel32, loaded only on Windows. */
	readonly loadPowerApi?: () => Promise<PowerApi>
}

/** Gives the power request back. Does nothing when none was taken, or when it was given back already. */
export type ReleasePower = () => void

const nothingToRelease: ReleasePower = () => undefined

/**
 * On Windows, keeps the engine going while the PC is locked: it holds a power request, so the
 * machine doesn't idle-sleep and drop the network, and the process isn't suspended in Modern
 * Standby, and it opts out of power throttling, which would slow its timers down in the
 * background. Runs that wait for hours on GitHub otherwise lose their connections. Explicitly
 * putting the machine to sleep or closing the lid still works.
 *
 * Resolves to the function that gives the request back, which shutdown calls once the sandboxes are
 * paused, so the machine can't fall asleep in the middle of that. Windows also drops it when the
 * process ends. Elsewhere it does nothing. It never fails the engine: when Windows says no, it logs
 * a warning.
 */
export async function keepAwake(options: KeepAwakeOptions): Promise<ReleasePower> {
	if ((options.platform ?? process.platform) !== 'win32') return nothingToRelease
	const loadPowerApi = options.loadPowerApi ?? loadWindowsPowerApi
	let api: PowerApi | undefined
	try {
		api = await loadedUnlessAborted(loadPowerApi(), options.abortSignal)
	} catch (error) {
		options.log(`Warning: can't keep Windows awake while the PC is locked: ${messageOf(error)}`)
		return nothingToRelease
	}
	// Shutdown may have started right as loading finished; it has nothing to give back then.
	if (api === undefined || options.abortSignal.aborted) return nothingToRelease
	let release = nothingToRelease
	try {
		release = once(api.holdPowerRequest(powerRequestReason))
	} catch (error) {
		options.log(`Warning: Windows may sleep while the PC is locked, which drops the network for running workflows: ${messageOf(error)}`)
	}
	try {
		api.optOutOfThrottling()
	} catch (error) {
		options.log(`Warning: Windows may throttle the engine in the background: ${messageOf(error)}`)
	}
	return release
}

/** The loaded power calls, or `undefined` once `abortSignal` aborts, whether or not loading ever settles. */
async function loadedUnlessAborted(loading: Promise<PowerApi>, abortSignal: AbortSignal): Promise<PowerApi | undefined> {
	if (abortSignal.aborted) return undefined
	const { promise: aborted, resolve } = Promise.withResolvers<undefined>()
	const onAbort = () => {
		resolve(undefined)
	}
	abortSignal.addEventListener('abort', onAbort, { once: true })
	try {
		return await Promise.race([loading, aborted])
	} finally {
		abortSignal.removeEventListener('abort', onAbort)
	}
}

function once(release: ReleasePower): ReleasePower {
	let released = false
	return () => {
		if (released) return
		released = true
		release()
	}
}

async function loadWindowsPowerApi(): Promise<PowerApi> {
	const { windowsPowerApi } = await import('./windows-power.mts')
	return windowsPowerApi()
}
