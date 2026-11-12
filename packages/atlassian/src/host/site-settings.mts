import type { HostToolContext } from '@mesh-flow/gateway'

/** The Atlassian products this connector speaks to. Each has its own settings, since a Data Center install often runs them on different hosts. */
export type Product = 'jira' | 'confluence'

/**
 * The names of a product's settings in the gateway's credential store:
 *
 * - `<product>/url`: the site, such as `https://example.atlassian.net` or `https://jira.example.com`;
 * - `<product>/token`: an API token on Cloud, a personal access token on Data Center;
 * - `<product>/email`: the account's email on Cloud, which goes with the API token. Data Center
 *   has none: without it, the token is sent as a personal access token.
 */
export function settingNames(product: Product) {
	return Object.freeze({ url: `${product}/url`, token: `${product}/token`, email: `${product}/email` })
}

/** Where a product runs, and how to sign in to it. */
export type SiteSettings =
	| { readonly deployment: 'cloud'; readonly url: string; readonly email: string; readonly token: string }
	| { readonly deployment: 'data-center'; readonly url: string; readonly token: string }

/**
 * The product's settings from the call's credential store, read on every call so a changed setting
 * counts at once, or an error saying how to set what's missing.
 */
export async function readSiteSettings(product: Product, { credentials, abortSignal }: HostToolContext): Promise<SiteSettings> {
	const names = settingNames(product)
	const [url, token, email] = await Promise.all([
		credentials.get(names.url, abortSignal),
		credentials.get(names.token, abortSignal),
		credentials.get(names.email, abortSignal),
	])
	if (url === undefined) throw new Error(`There is no ${product} site. Set it with \`mesh-flow credential set ${names.url}\`.`)
	if (token === undefined) throw new Error(`There is no ${product} token. Set it with \`mesh-flow credential set ${names.token}\`.`)
	const site = siteUrl(url, names.url)
	return email === undefined ? { deployment: 'data-center', url: site, token } : { deployment: 'cloud', url: site, email, token }
}

/** The site as an http(s) URL without a trailing slash, or an error naming the setting. */
function siteUrl(value: string, setting: string): string {
	const trimmed = value.trim().replace(/\/+$/, '')
	if (!URL.canParse(trimmed) || !/^https?:$/.test(new URL(trimmed).protocol))
		throw new Error(`${setting} has to be an http(s) URL, such as https://example.atlassian.net.`)
	return trimmed
}
