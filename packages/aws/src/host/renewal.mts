import { msPerMinute, msPerSecond } from './time.mts'

/** How long before its end a token or credential is renewed, so it doesn't end mid-call. */
export const renewAheadMs = 5 * msPerMinute

/**
 * How long a token or credential has to hold at least to be handed out, so the call it's for gets
 * there in time.
 */
export const useAheadMs = 30 * msPerSecond

/** Whether something that ends at `expiresAt` still holds long enough at `now` for one more call. */
export function lastsForUse(expiresAt: Date, now: Date): boolean {
	return expiresAt.getTime() - useAheadMs > now.getTime()
}

/** Whether something that ends at `expiresAt` still holds for a while at `now`. */
export function lastsBeyondRenewal(expiresAt: Date, now: Date): boolean {
	return expiresAt.getTime() - renewAheadMs > now.getTime()
}
