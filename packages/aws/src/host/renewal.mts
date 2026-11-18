import { duration } from '@mesh-flow/duration'

/** How long before its end a token or credential is renewed, so it doesn't end mid-call. */
export const renewAhead = duration.of('5m')

/**
 * How long a token or credential has to hold at least to be handed out, so the call it's for gets
 * there in time.
 */
export const useAhead = duration.of('30s')

/** Whether something that ends at `expiresAt` still holds long enough at `now` for one more call. */
export function lastsForUse(expiresAt: Date, now: Date): boolean {
	return useAhead.before(expiresAt) > now
}

/** Whether something that ends at `expiresAt` still holds for a while at `now`. */
export function lastsBeyondRenewal(expiresAt: Date, now: Date): boolean {
	return renewAhead.before(expiresAt) > now
}
