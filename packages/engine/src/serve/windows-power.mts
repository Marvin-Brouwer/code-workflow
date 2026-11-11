/**
 * The Windows power calls `keepAwake` needs, through kernel32 with koffi. Only loaded on Windows.
 *
 * @module
 */
import koffi from 'koffi'

/** Asks Windows to keep the machine and this process going, and to stop asking. */
export interface PowerApi {
	/**
	 * Takes a power request with `reason`, which `powercfg /requests` shows: the system stays out of
	 * idle sleep and this process keeps running, also with the screen locked or off. Returns a
	 * function that gives it back.
	 */
	readonly holdPowerRequest: (reason: string) => () => void
	/** Opts this process out of power throttling (EcoQoS), which slows a background process down. */
	readonly optOutOfThrottling: () => void
}

/** `POWER_REQUEST_CONTEXT_VERSION`. */
const reasonContextVersion = 0
/** `POWER_REQUEST_CONTEXT_SIMPLE_STRING`: the context holds one reason string. */
const simpleReasonString = 0x1
/** `PowerRequestSystemRequired`: no idle sleep while it's held. */
const systemRequired = 1
/** `PowerRequestExecutionRequired`: the process keeps running, also in Modern Standby with the screen off. */
const executionRequired = 3
/** `INVALID_HANDLE_VALUE`. */
const invalidHandle = -1
/** `GetCurrentProcess()`'s pseudo handle. */
const currentProcess = -1
/** `ProcessPowerThrottling` in `PROCESS_INFORMATION_CLASS`. */
const processPowerThrottling = 4
/** `PROCESS_POWER_THROTTLING_CURRENT_VERSION`. */
const throttlingStateVersion = 1
/** `PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION`. */
const throttlingControls = 0x1 | 0x4
/** A state mask without the controls: they are switched off. */
const throttlingOff = 0

/** The bound functions: koffi registers struct names process-wide, so they're bound once. */
let bound: PowerApi | undefined

/** The kernel32 functions, bound on the first call. Throws when they can't be loaded, which only happens off Windows. */
export function windowsPowerApi(): PowerApi {
	bound ??= bindWindowsPowerApi()
	return bound
}

function bindWindowsPowerApi(): PowerApi {
	const kernel32 = koffi.load('kernel32.dll')
	koffi.struct('REASON_CONTEXT', { Version: 'uint32', Flags: 'uint32', SimpleReasonString: 'str16' })
	const throttlingState = koffi.struct('PROCESS_POWER_THROTTLING_STATE', {
		Version: 'uint32',
		ControlMask: 'uint32',
		StateMask: 'uint32',
	})
	const powerCreateRequest = kernel32.func('intptr __stdcall PowerCreateRequest(REASON_CONTEXT *context)')
	const powerSetRequest = kernel32.func('int __stdcall PowerSetRequest(intptr request, int type)')
	const powerClearRequest = kernel32.func('int __stdcall PowerClearRequest(intptr request, int type)')
	const closeHandle = kernel32.func('int __stdcall CloseHandle(intptr handle)')
	const setProcessInformation = kernel32.func(
		'int __stdcall SetProcessInformation(intptr process, int infoClass, PROCESS_POWER_THROTTLING_STATE *info, uint32 size)',
	)
	const getLastError = kernel32.func('uint32 __stdcall GetLastError()')
	const windowsError = (call: string) => new Error(`${call} failed with Windows error ${String(getLastError())}.`)

	return {
		holdPowerRequest(reason) {
			const request: unknown = powerCreateRequest({ Version: reasonContextVersion, Flags: simpleReasonString, SimpleReasonString: reason })
			if (typeof request !== 'number' || request === invalidHandle || request === 0) throw windowsError('PowerCreateRequest')
			const requestTypes = [systemRequired, executionRequired]
			for (const type of requestTypes) {
				if (powerSetRequest(request, type) === 0) {
					const error = windowsError('PowerSetRequest')
					closeHandle(request)
					throw error
				}
			}
			return () => {
				for (const type of requestTypes) powerClearRequest(request, type)
				closeHandle(request)
			}
		},
		optOutOfThrottling() {
			const state = { Version: throttlingStateVersion, ControlMask: throttlingControls, StateMask: throttlingOff }
			if (setProcessInformation(currentProcess, processPowerThrottling, state, koffi.sizeof(throttlingState)) === 0)
				throw windowsError('SetProcessInformation')
		},
	}
}
