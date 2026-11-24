/** The name a provider's API key has in the credential store. */
export function providerCredential(name: string): string {
	return `provider/${name}`
}
