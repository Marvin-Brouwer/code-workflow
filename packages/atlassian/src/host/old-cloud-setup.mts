import type { CredentialReader } from '@mesh-flow/gateway'
import { cloudCredentialNames, dataCenterCredentialNames, productNames, type Product } from './site.mts'

/**
 * Whether the product is set up the way Atlassian Cloud was before Jira and Confluence shared one
 * site: `<product>/url`, `<product>/email` and `<product>/token`. Data Center has no email, so
 * `<product>/email` tells the two apart; without this, the old Cloud site would be taken for Data
 * Center and its API token sent as a personal access token.
 */
export async function hasOldCloudSetup(product: Product, credentials: CredentialReader, abortSignal: AbortSignal): Promise<boolean> {
	return (await credentials.get(oldCloudEmail(product), abortSignal)) !== undefined
}

/** What to do about an old Cloud setup of `product`. */
export function oldCloudSetupMessage(product: Product): string {
	const cloud = cloudCredentialNames
	const dataCenter = dataCenterCredentialNames(product)
	return (
		`${dataCenter.url} and ${oldCloudEmail(product)} are the Atlassian Cloud settings from before ${productNames[product]} and the other ` +
		`products shared one site. Set ${cloud.url}, ${cloud.email} and ${cloud.token} instead, then remove ${dataCenter.url}, ` +
		`${oldCloudEmail(product)} and ${dataCenter.token} with \`mesh-flow credential remove\`.`
	)
}

/** Where the old Cloud setup kept the account's email for `product`. */
function oldCloudEmail(product: Product): string {
	return `${product}/email`
}
