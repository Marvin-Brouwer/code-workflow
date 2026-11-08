import { abortable } from '@mesh-flow/sandbox'

/**
 * Waits until `work` settles or `signal` aborts, whichever comes first, and never rejects. For
 * shutdown: work that ignores its signal can't hold the engine up past a deadline.
 */
export function settleWithin(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
	return abortable(work, signal).then(
		() => undefined,
		() => undefined,
	)
}
