/**
 * The mesh-flow gateway: the host side of every call that needs a credential. It holds the
 * credentials, runs host tools and sends model requests for runs in sandboxes that hold none, and
 * has the `fetch` that host tools send their API requests through.
 *
 * @module
 */
export { connectorCredentials } from '../credentials/connector-credentials.mts'
export { CredentialName, openCredentialStore, type CredentialReader, type CredentialStore } from '../credentials/credential-store.mts'
export { siteUrl } from '../credentials/site-url.mts'
export { defaultStoreKey, keyFile, keychainKey, type DefaultStoreKeyOptions, type StoreKey } from '../credentials/store-key.mts'
export {
	openGateway,
	tokensPerEndpoint,
	type AcceptedCall,
	type Gateway,
	type GatewayOptions,
	type InterruptedCall,
	type RunAccess,
} from '../gateway.mts'
export { openGatewayHome, type GatewayHome } from '../gateway-home.mts'
export { gone, notFound, unauthorized, unavailable } from '../http/http-statuses.mts'
export {
	defaultFetchRetry,
	readsOnly,
	retryingFetch,
	type FetchResends,
	type FetchRetryOptions,
	type OutgoingRequest,
} from '../http/retrying-fetch.mts'
export type { ConnectorRegistryRequest, RegistryFetch, ResolveRegistryFetch } from '../packages/connector-registry.mts'
export { maxPackageBytes, type FetchedPackage } from '../packages/fetch-package.mts'
export { isPackageDownload, openPackageCache, type PackageCache } from '../packages/package-cache.mts'
export { knownKinds } from '../providers/model-apis.mts'
export { oneAtATime, type OneAtATime } from '../one-at-a-time.mts'
export { projectUrl } from '../project-url.mts'
export {
	openProviderSettings,
	providerCredential,
	ProviderName,
	ProviderSetting,
	type ProviderSettings,
} from '../providers/provider-settings.mts'
export { resolveModel, type ModelChoice } from '../providers/resolve-model.mts'
export { mergeUsage, ModelUsage, RunUsage } from '../providers/usage.mts'
export type { ConnectorLogin, ConnectorLoginContext, LoginPrompt } from '../tools/connector-login.mts'
export {
	connectorHost,
	hostTool,
	HostToolInputError,
	HostToolTransientError,
	isTransient,
	type ConnectorHost,
	type ConnectorHostExtras,
	type ConnectorHostOptions,
	type HostTool,
	type HostToolContext,
	type ToolDefinition,
} from '../tools/host-tool.mts'
export { SignInNeeded, signInOf } from '../tools/sign-in-needed.mts'
