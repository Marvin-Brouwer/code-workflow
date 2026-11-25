/**
 * What the settings and engine routes answer, as the page checks it. The page can't import these
 * from the engine and the gateway, which are Node packages, so they're written out again here; a
 * test holds them to the originals.
 *
 * @module
 */
import { z } from 'zod'

/**
 * A provider of the app's config, as the settings list it: never its key, only whether it has one
 * for where the config sends it, and else where its key was set for.
 */
export const ListedProvider = z.object({
	name: z.string(),
	kind: z.string(),
	baseUrl: z.string().optional(),
	hasKey: z.boolean(),
	keySetFor: z.string().optional(),
})
export type ListedProvider = z.infer<typeof ListedProvider>

/** A model a provider offers, and whether agents can use it: `ListedModel` in `@mesh-flow/engine`. */
export const ListedModel = z.object({ id: z.string(), usable: z.boolean() })
export type ListedModel = z.infer<typeof ListedModel>

/** The models a provider offers its key: `ProviderModelList` in `@mesh-flow/engine`. */
export const ProviderModelList = z.discriminatedUnion('source', [
	z.object({
		source: z.enum(['provider', 'catalog']),
		models: z.array(ListedModel),
	}),
	z.object({ source: z.literal('failed'), reason: z.string() }),
])
export type ProviderModelList = z.infer<typeof ProviderModelList>

/** A connector package the engine loads: `ConnectorSetting` in `@mesh-flow/engine`. */
export const ConnectorPackage = z.object({ package: z.string() })
export type ConnectorPackage = z.infer<typeof ConnectorPackage>

/** A connector the running engine loaded. */
export const ShownConnector = z.object({ name: z.string(), package: z.string(), signsIn: z.boolean() })
export type ShownConnector = z.infer<typeof ShownConnector>

/** A sign-in under way: where to sign in once there is a code, or why the last try failed. */
export const SignInState = z.object({
	connector: z.string(),
	prompt: z.object({ url: z.string(), code: z.string(), expiresAt: z.iso.datetime() }).optional(),
	error: z.string().optional(),
})
export type SignInState = z.infer<typeof SignInState>

/** What sets a missing setting: see `SettingFix` in `@mesh-flow/gateway`. */
export const SettingFix = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('provider-key'), provider: z.string() }),
	z.object({ kind: z.literal('credential'), name: z.string(), example: z.string().optional() }),
	z.object({ kind: z.literal('connector-for-tools'), tools: z.array(z.string()) }),
	z.object({ kind: z.literal('connector'), connector: z.string() }),
	z.object({ kind: z.literal('other') }),
])
export type SettingFix = z.infer<typeof SettingFix>

/** A setting an app still needs: a line that says what to do, and what sets it. */
export const MissingSetting = z.object({ message: z.string(), fix: SettingFix })
export type MissingSetting = z.infer<typeof MissingSetting>

/** A change the server answered without a body. */
export const NoContent = z.undefined()

/**
 * A credential's name, as `CredentialName` in `@mesh-flow/gateway` takes it. The page checks it
 * itself, since the address folds away a `.` or `..` part before the server sees it.
 */
export const CredentialName = z
	.string()
	.regex(/^[\w./-]{1,128}$/, 'Use 1 to 128 letters, digits, _, ., / or -.')
	.refine((name) => !name.split('/').some((part) => part === '.' || part === '..'), 'No part of the name can be . or ..')

/** The settings route of credential `name`, whose parts are split by `/` as the name's are. */
export function credentialPath(name: string): string {
	return `/settings/credentials/${name.split('/').map(encodeURIComponent).join('/')}`
}

/** What a provider's key is stored as in the credential store: `provider/<name>`. */
const providerCredentialPrefix = 'provider/'

/** The credential provider `provider`'s key is stored as. */
export function providerCredential(provider: string): string {
	return `${providerCredentialPrefix}${provider}`
}

/** The provider whose key credential `name` is, if it's one. */
export function providerOfCredential(name: string): string | undefined {
	return name.startsWith(providerCredentialPrefix) ? name.slice(providerCredentialPrefix.length) : undefined
}

/** Whether `provider` has a key, and when its key was set for another origin, which one: it isn't used until it's set again. */
export function providerKeyText(provider: ListedProvider): string {
	if (provider.hasKey) return 'set'
	if (provider.keySetFor === undefined) return 'not set'
	return `not set (set for ${provider.keySetFor} before)`
}
