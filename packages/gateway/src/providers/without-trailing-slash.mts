/** A URL or path without the slashes it ends with. */
export function withoutTrailingSlash(url: string): string {
	return url.replace(/\/+$/, '')
}
