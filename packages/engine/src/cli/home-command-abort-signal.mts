/** How long a command on the engine's home may take: it only reads and writes files there. */
const homeCommandMs = 30_000

/** The signal of a command that works on the engine's home directly, without a running engine. */
export function homeCommandAbortSignal(): AbortSignal {
	return AbortSignal.timeout(homeCommandMs)
}
