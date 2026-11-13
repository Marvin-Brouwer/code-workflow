import { siteUrl, type HostToolContext } from '@mesh-flow/gateway'

/**
 * The Atlassian products this connector speaks to. Each has its own credentials, since a Data Center
 * install often runs them on different hosts.
 */
export type Product = 'jira' | 'confluence'

/**
 * The names of a product's credentials in the gateway's credential store:
 *
 * - `<product>/url`: the site, such as `https://example.atlassian.net` or `https://jira.example.com`;
 * - `<product>/token`: an API token on Cloud, a personal access token on Data Center;
 * - `<product>/email`: the account's email on Cloud, which goes with the API token. Data Center
 *   has none: without it, the token is sent as a personal access token.
 */
export function credentialNames(product: Product): Readonly<{ url: string; token: string; email: string }> {
	return Object.freeze({ url: `${product}/url`, token: `${product}/token`, email: `${product}/email` })
}

/** How a product is named in a message. */
const productNames: Readonly<Record<Product, string>> = Object.freeze({ jira: 'Jira', confluence: 'Confluence' })

/** What a site's URL looks like, for a message about one that isn't a URL. */
const exampleSiteUrl = 'https://example.atlassian.net'

/** Where a product runs, and how to sign in to it. */
export type Site =
	| { readonly deployment: 'cloud'; readonly url: string; readonly email: string; readonly token: string }
	| { readonly deployment: 'data-center'; readonly url: string; readonly token: string }

/**
 * The product's site from the call's credential store, read on every call so a changed credential
 * counts at once, or an error saying how to set what's missing.
 */
export async function readSite(product: Product, { credentials, abortSignal }: HostToolContext): Promise<Site> {
	const names = credentialNames(product)
	const [url, token, email] = await Promise.all([
		credentials.get(names.url, abortSignal),
		credentials.get(names.token, abortSignal),
		credentials.get(names.email, abortSignal),
	])
	if (url === undefined)
		throw new Error(`There is no ${productNames[product]} site. Set it with \`mesh-flow credential set ${names.url}\`.`)
	if (token === undefined)
		throw new Error(`There is no ${productNames[product]} token. Set it with \`mesh-flow credential set ${names.token}\`.`)
	const site = siteUrl(url, names.url, exampleSiteUrl)
	return email === undefined ? { deployment: 'data-center', url: site, token } : { deployment: 'cloud', url: site, email, token }
}
