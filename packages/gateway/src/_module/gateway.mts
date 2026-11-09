/**
 * The mesh-flow gateway: the host side of every call that needs a credential. It holds the
 * credentials, runs host tools and sends model requests for runs in sandboxes that hold none.
 *
 * @module
 */
export { CredentialName, openCredentialStore, type CredentialReader, type CredentialStore } from '../credentials/credential-store.mts'
export { defaultStoreKey, keyFile, keychainKey, type StoreKey } from '../credentials/store-key.mts'
export { openGateway, tokensPerEndpoint, type AcceptedCall, type Gateway, type GatewayOptions, type InterruptedCall } from '../gateway.mts'
export { openGatewayHome, type GatewayHome } from '../gateway-home.mts'
export { knownKinds, supportedApis } from '../providers/model-apis.mts'
export {
	openProviderSettings,
	providerCredential,
	ProviderName,
	ProviderSetting,
	type ProviderSettings,
} from '../providers/provider-settings.mts'
export { resolveModel, type ModelChoice } from '../providers/resolve-model.mts'
export { ModelUsage, RunUsage } from '../providers/usage.mts'
export { hostTool, HostToolInputError, type HostTool, type HostToolContext, type ToolDefinition } from '../tools/host-tool.mts'
