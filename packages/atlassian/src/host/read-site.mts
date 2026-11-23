import { siteUrl, type HostToolContext } from '@mesh-flow/gateway'
import { hasOldCloudSetup, oldCloudSetupMessage } from './old-cloud-setup.mts'
import {
	cloudCredentialNames,
	dataCenterCredentialNames,
	exampleCloudUrl,
	exampleDataCenterUrls,
	productNames,
	type Product,
	type Site,
} from './site.mts'

/**
 * The product's site from the call's credential store, read on every call so a changed credential
 * counts at once: its Data Center site when `<product>/url` is set, the Cloud site otherwise. An
 * error says how to set what's missing.
 */
export async function readSite(product: Product, { credentials, abortSignal }: HostToolContext): Promise<Site> {
	const dataCenter = dataCenterCredentialNames(product)
	const dataCenterUrl = await credentials.get(dataCenter.url, abortSignal)
	if (dataCenterUrl !== undefined) {
		if (await hasOldCloudSetup(product, credentials, abortSignal)) throw new Error(oldCloudSetupMessage(product))
		const token = await credentials.get(dataCenter.token, abortSignal)
		if (token === undefined)
			throw new Error(
				`There is no ${productNames[product]} Data Center token. Set it with \`mesh-flow credential set ${dataCenter.token}\`.`,
			)
		return { deployment: 'data-center', url: siteUrl(dataCenterUrl, dataCenter.url, exampleDataCenterUrls[product]), token }
	}
	const cloud = cloudCredentialNames
	const [url, email, token] = await Promise.all([
		credentials.get(cloud.url, abortSignal),
		credentials.get(cloud.email, abortSignal),
		credentials.get(cloud.token, abortSignal),
	])
	if (url === undefined || email === undefined || token === undefined) {
		throw new Error(
			`There is no ${productNames[product]} site. Set ${cloud.url}, ${cloud.email} and ${cloud.token} for Atlassian Cloud, ` +
				`or ${dataCenter.url} and ${dataCenter.token} for ${productNames[product]} Data Center, each with \`mesh-flow credential set\`.`,
		)
	}
	return { deployment: 'cloud', url: siteUrl(url, cloud.url, exampleCloudUrl), email, token }
}
