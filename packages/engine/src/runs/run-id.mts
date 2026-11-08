import { randomBytes } from 'node:crypto'
import { z } from 'zod'

/** A run's id: `run-` and 12 hex digits. It names a directory, so nothing else is accepted. */
export const RunId = z.string().regex(/^run-[0-9a-f]{12}$/, "This isn't a run id.")
export type RunId = z.infer<typeof RunId>

/** A new random run id. */
export function newRunId(): RunId {
	return `run-${randomBytes(6).toString('hex')}`
}
