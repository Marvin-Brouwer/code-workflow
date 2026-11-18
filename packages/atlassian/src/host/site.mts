import { missingCredentials, siteUrl, type CredentialReader, type HostToolContext, type MissingSetting } from '@mesh-flow/gateway'

/** The Atlassian products this connector speaks to. */
export type Product = 'jira' | 'confluence'

/**
 * The names of the Atlassian Cloud credentials in the gateway's credential store. One site and one
 * API token serve Jira and Confluence:
 *
 * - `atlassian/url`: the site, such as `https://example.atlassian.net`;
 * - `atlassian/email`: the account's email, which goes with the API token;
 * - `atlassian/token`: the API token.
 */
export const cloudCredentialNames = Object.freeze({ url: 'atlassian/url', email: 'atlassian/email', token: 'atlassian/token' })

/**
 * The names of a product's Data Center credentials in the gateway's credential store. Each product
 * has its own, since a Data Center install runs them on their own hosts:
 *
 * - `<product>/url`: the product's site, with its context path if it has one, such as
 *   `https://jira.example.com`;
 * - `<product>/token`: a personal access token.
 *
 * A product whose `<product>/url` is set is spoken to as Data Center; one without, as Cloud.
 *
 * @param product - The product whose credentials to name: `jira` or `confluence`.
 * @returns The two names.
 *
 * @example
 * ```ts
 * const names = dataCenterCredentialNames('confluence')
 * // { url: 'confluence/url', token: 'confluence/token' }
 * ```
 */
export function dataCenterCredentialNames(product: Product): Readonly<{ url: string; token: string }> {
	return Object.freeze({ url: `${product}/url`, token: `${product}/token` })
}

/** How a product is named in a message. */
const productNames: Readonly<Record<Product, string>> = Object.freeze({ jira: 'Jira', confluence: 'Confluence' })

/** What a Cloud site's URL looks like. */
const exampleCloudUrl = 'https://example.atlassian.net'

/** What a Data Center product's URL looks like. */
const exampleDataCenterUrls: Readonly<Record<Product, string>> = Object.freeze({
	jira: 'https://jira.example.com',
	confluence: 'https://wiki.example.com',
})

/** Where a product runs, and how to sign in to it. */
export type Site =
	| { readonly deployment: 'cloud'; readonly url: string; readonly email: string; readonly token: string }
	| { readonly deployment: 'data-center'; readonly url: string; readonly token: string }

/**
 * The product's site from the call's credential store, read on every call so a changed credential
 * counts at once: its Data Center site when `<product>/url` is set, the Cloud site otherwise. An
 * error says how to set what's missing.
 */
export async function readSite(product: Product, { credentials, abortSignal }: HostToolContext): Promise<Site> {
	const dataCenter = dataCenterCredentialNames(product)
	const dataCenterUrl = await credentials.get(dataCenter.url, abortSignal)
	if (dataCenterUrl !== undefined) {
		const token = await credentials.get(dataCenter.token, abortSignal)
		if (token === undefined)
			throw new Error(
				`There is no ${productNames[product]} Data Center token. Set it with \`mesh-flow credential set ${dataCenter.token}\`.`,
			)
		return { deployment: 'data-center', url: siteUrl(dataCenterUrl, dataCenter.url, exampleDataCenterUrls[product]), token }
	}
	const names = cloudCredentialNames
	const [url, email, token] = await Promise.all([
		credentials.get(names.url, abortSignal),
		credentials.get(names.email, abortSignal),
		credentials.get(names.token, abortSignal),
	])
	if (url === undefined || email === undefined || token === undefined) {
		throw new Error(
			`There is no ${productNames[product]} site. For Atlassian Cloud, set ${names.url}, ${names.email} and ${names.token}; ` +
				`for ${productNames[product]} Data Center, set ${dataCenter.url} and ${dataCenter.token}, with \`mesh-flow credential set\`.`,
		)
	}
	return { deployment: 'cloud', url: siteUrl(url, names.url, exampleCloudUrl), email, token }
}

/**
 * What the connector still needs. A product with a Data Center site needs its token. Without any
 * Data Center site, the Cloud site is what's used, so its three settings are what's asked for.
 * With one product on Data Center, the other product's Cloud settings aren't asked for: an app may
 * not use it, and a call to it says what to set.
 */
export async function missingSiteSettings(credentials: CredentialReader, abortSignal: AbortSignal): Promise<MissingSetting[]> {
	const products: readonly Product[] = ['jira', 'confluence']
	const urls = await Promise.all(products.map((product) => credentials.get(dataCenterCredentialNames(product).url, abortSignal)))
	const onDataCenter = products.filter((_product, index) => urls[index] !== undefined)
	if (onDataCenter.length > 0)
		return missingCredentials(
			credentials,
			onDataCenter.map((product) => ({ name: dataCenterCredentialNames(product).token })),
			abortSignal,
		)
	return missingCredentials(
		credentials,
		[
			{ name: cloudCredentialNames.url, example: exampleCloudUrl },
			{ name: cloudCredentialNames.email, example: 'bot@example.com' },
			{ name: cloudCredentialNames.token },
		],
		abortSignal,
	)
}
