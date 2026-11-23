/** The Atlassian products this connector speaks to. */
export const products = Object.freeze(['jira', 'confluence'] as const)
export type Product = (typeof products)[number]

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
export const productNames: Readonly<Record<Product, string>> = Object.freeze({ jira: 'Jira', confluence: 'Confluence' })

/** What a Cloud site's URL looks like. */
export const exampleCloudUrl = 'https://example.atlassian.net'

/** What a Data Center product's URL looks like. */
export const exampleDataCenterUrls: Readonly<Record<Product, string>> = Object.freeze({
	jira: 'https://jira.example.com',
	confluence: 'https://wiki.example.com',
})

/** Where a product runs, and how to sign in to it. */
export type Site =
	| { readonly deployment: 'cloud'; readonly url: string; readonly email: string; readonly token: string }
	| { readonly deployment: 'data-center'; readonly url: string; readonly token: string }
