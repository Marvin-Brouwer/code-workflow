/** How long before its end a token or credential is renewed, so it doesn't end mid-call. */
export const renewAheadMs = 5 * 60 * 1000

/** Whether something that ends at `expiresAt` still holds for a while at `now`. */
export function lastsBeyondRenewal(expiresAt: Date, now: Date): boolean {
	return expiresAt.getTime() - renewAheadMs > now.getTime()
}
