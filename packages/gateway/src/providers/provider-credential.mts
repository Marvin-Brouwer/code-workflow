/** What the names of providers' API keys start with in the credential store. */
const providerCredentialPrefix = 'provider/'

/** The name a provider's API key has in the credential store. */
export function providerCredential(name: string): string {
	return `${providerCredentialPrefix}${name}`
}

/**
 * Whether `name` is a provider's API key in the credential store. Those are set with
 * `storeProviderKey`, which ties them to an origin, never as a plain credential.
 */
export function isProviderCredential(name: string): boolean {
	return name.startsWith(providerCredentialPrefix)
}

/** Why `name` isn't set as a plain credential: it's a provider's key, which is tied to the origin its provider is at. */
export function providerKeyRefusal(name: string): string {
	const provider = name.slice(providerCredentialPrefix.length)
	return `${name} is a provider's key, which is tied to where its provider is. Set it with \`mesh-flow provider key ${provider}\`, or on the providers page.`
}
