import { missingCredentials, type CredentialReader, type MissingSetting } from '@mesh-flow/gateway'
import { hasOldCloudSetup, oldCloudSetupMessage } from './old-cloud-setup.mts'
import { cloudCredentialNames, dataCenterCredentialNames, exampleCloudUrl, products } from './site.mts'

/** What the Cloud account's email looks like. */
const exampleCloudEmail = 'bot@example.com'

/**
 * What the connector still needs. A product with a Data Center site needs its token, unless it's
 * the old Cloud setup (`hasOldCloudSetup`), which has to move to the shared Cloud site first.
 * Without any Data Center site, the Cloud site is what's used, so its three settings are what's
 * asked for.
 * With one product on Data Center, the other product's Cloud settings aren't asked for: an app may
 * not use it, and a call to it says what to set.
 */
export async function missingSiteSettings(credentials: CredentialReader, abortSignal: AbortSignal): Promise<MissingSetting[]> {
	const urls = await Promise.all(products.map((product) => credentials.get(dataCenterCredentialNames(product).url, abortSignal)))
	const onDataCenter = products.filter((_product, index) => urls[index] !== undefined)
	if (onDataCenter.length > 0) {
		const hasOldSetup = await Promise.all(onDataCenter.map((product) => hasOldCloudSetup(product, credentials, abortSignal)))
		const oldSetups = onDataCenter.filter((_product, index) => hasOldSetup[index])
		const dataCenterProducts = onDataCenter.filter((_product, index) => !hasOldSetup[index])
		const toMove = oldSetups.map((product): MissingSetting => ({ message: oldCloudSetupMessage(product), fix: { kind: 'other' } }))
		const tokens = await missingCredentials(
			credentials,
			dataCenterProducts.map((product) => ({ name: dataCenterCredentialNames(product).token })),
			abortSignal,
		)
		return [...toMove, ...tokens]
	}
	return missingCredentials(
		credentials,
		[
			{ name: cloudCredentialNames.url, example: exampleCloudUrl },
			{ name: cloudCredentialNames.email, example: exampleCloudEmail },
			{ name: cloudCredentialNames.token },
		],
		abortSignal,
	)
}
