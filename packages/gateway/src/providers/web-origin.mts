/** The schemes a provider's key may be sent over: other schemes have no origin to tie a key to. */
const webSchemes: readonly string[] = ['https:', 'http:']

/** The origin of `url`, or `undefined` when it isn't a web URL, such as pi-ai's empty base URL of a kind that needs one. */
export function webOrigin(url: string): string | undefined {
	const parsed = URL.parse(url)
	return parsed !== null && webSchemes.includes(parsed.protocol) ? parsed.origin : undefined
}
