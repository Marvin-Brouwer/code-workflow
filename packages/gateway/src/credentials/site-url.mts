/**
 * A site's URL as a connector takes it from the credential store: http or https, without spaces
 * around it or a slash at the end. Anything else is an error naming the credential and an example
 * of what it should hold.
 */
export function siteUrl(value: string, credentialName: string, example: string): string {
	const parsed = URL.parse(value.trim())
	if (parsed === null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:'))
		// The value stays out of the error: what was stored by mistake may be a token.
		throw new Error(`${credentialName} isn't an http(s) URL. Set it to where the site is, such as ${example}.`)
	return parsed.href.replace(/\/+$/, '')
}
