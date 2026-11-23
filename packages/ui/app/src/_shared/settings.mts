/**
 * What the settings and engine routes answer, as the page checks it. The page can't import these
 * from the engine and the gateway, which are Node packages, so they're written out again here; a
 * test holds them to the originals.
 *
 * @module
 */
import { z } from 'zod'

/** A provider kind the gateway knows, and how many models it has. */
export const ProviderKind = z.object({ kind: z.string(), models: z.number() })
export type ProviderKind = z.infer<typeof ProviderKind>

/** A provider as the settings list it: never its key, only whether it has one. */
export const ListedProvider = z.object({ name: z.string(), kind: z.string(), baseUrl: z.string().optional(), hasKey: z.boolean() })
export type ListedProvider = z.infer<typeof ListedProvider>

/** The names `ProviderName` in `@mesh-flow/gateway` takes, as an input's `pattern`. */
export const providerNamePattern = '[a-z0-9][\\w\\-]{0,63}'

/** A connector package the engine loads. */
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
	z.object({ kind: z.literal('provider'), model: z.string() }),
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
