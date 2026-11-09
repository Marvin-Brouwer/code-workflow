/** Why the engine refused a request, so the control API can answer with the right status. */
export type EngineErrorCode = 'not-found' | 'conflict' | 'invalid' | 'unavailable'

/** A request the engine refused: an unknown run, a run in the wrong state, a bad workflow. */
export class EngineError extends Error {
	readonly code: EngineErrorCode

	constructor(code: EngineErrorCode, message: string) {
		super(message)
		this.name = 'EngineError'
		this.code = code
	}
}
