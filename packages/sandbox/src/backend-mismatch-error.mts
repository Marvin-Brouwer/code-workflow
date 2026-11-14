import type { BackendName } from './backend-name.mts'
import type { PausedSandbox } from './paused-sandbox.mts'

/** Thrown when a sandbox is resumed on another backend than the one that paused it. */
export class BackendMismatchError extends Error {
	override readonly name = 'BackendMismatchError'
	readonly paused: BackendName
	readonly backend: BackendName

	constructor(paused: BackendName, backend: BackendName) {
		super(`This sandbox was paused by ${paused} and can only be resumed there, not on ${backend}.`)
		this.paused = paused
		this.backend = backend
	}
}

/** Throws a {@link BackendMismatchError} unless `paused` was made by `backend`. */
export function assertPausedBy(paused: PausedSandbox, backend: BackendName): void {
	if (paused.backend !== backend) throw new BackendMismatchError(paused.backend, backend)
}
