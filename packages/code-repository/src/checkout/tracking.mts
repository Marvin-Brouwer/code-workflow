/** The remote a sandbox's checkout knows: a ref under it tracks what the host has pushed. */
export const origin = 'origin'

/** Where a checkout tracks a branch as the remote has it. */
export function trackingRef(branch: string): string {
	return `refs/remotes/${origin}/${branch}`
}
