/**
 * A site's URL as a connector takes it from the credential store: http or https, without spaces
 * around it or a slash at the end. Anything else is an error naming the credential and an example
 * of what it should hold.
 */
export function siteUrl(value: string, credentialName: string, example: string): string {
	const parsed = URL.parse(value.trim())
	if (parsed === null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:'))
		throw new Error(`${credentialName} is ${value}, which isn't an http(s) URL. Set it to where the site is, such as ${example}.`)
	return parsed.href.replace(/\/+$/, '')
}
