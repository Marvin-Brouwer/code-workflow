/** How many hex digits a commit id has. */
const shaLength = 40

/** A commit id GitLab hasn't filled in, as on a merge request it is still preparing: all zeros. */
export const noCommit = '0'.repeat(shaLength)

/** Whether `sha` is {@link noCommit}. */
export function isNoCommit(sha: string): boolean {
	return /^0+$/.test(sha)
}
