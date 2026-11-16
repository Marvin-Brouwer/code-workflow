/** Characters a code host allows in a name and Windows doesn't in a file name. */
const notInFileNames = /[<>:"|?*\\]/g

/** A path segment Windows takes as a device, or trims the end of: `con`, `aux`, `com1`, or one ending in a dot or a space. */
const notAFileOnWindows = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$|[. ]$/i

/**
 * A `/`-separated name, such as a branch or a repository, as a relative path that works as one on
 * every platform: each segment has what Windows refuses replaced, and one Windows would take as a
 * device, or trim, gets a `-` at the end. The same name gives the same path everywhere.
 */
export function filePathOf(name: string): string {
	return name
		.split('/')
		.map((segment) => {
			const safe = segment.replace(notInFileNames, '-')
			return notAFileOnWindows.test(safe) ? `${safe}-` : safe
		})
		.join('/')
}
