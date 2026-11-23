import type { CredentialReader } from '../credentials/credential-store.mts'
import type { MissingSetting, SettingFix } from './missing-setting.mts'

/** A credential a connector reads, and what its value looks like. */
export interface WantedCredential {
	readonly name: string
	/** A value of the right shape, such as `https://example.atlassian.net`, for the message and the form. */
	readonly example?: string
}

/**
 * The credentials of `wanted` that aren't set, as missing settings: what a connector's
 * `missingSettings` usually is.
 *
 * @example
 * ```ts
 * connectorHost('github', tools, {
 * 	missingSettings: ({ credentials }, abortSignal) => missingCredentials(credentials, [{ name: 'github/token' }], abortSignal),
 * })
 * ```
 */
export async function missingCredentials(
	credentials: CredentialReader,
	wanted: readonly WantedCredential[],
	abortSignal: AbortSignal,
): Promise<MissingSetting[]> {
	const values = await Promise.all(wanted.map(({ name }) => credentials.get(name, abortSignal)))
	return wanted.flatMap(({ name, example }, index) => {
		if (values[index] !== undefined) return []
		const command = example === undefined ? `mesh-flow credential set ${name}` : `echo '${example}' | mesh-flow credential set ${name}`
		const fix: SettingFix = { kind: 'credential', name, example }
		return [{ message: `${name} isn't set. Set it with \`${command}\`.`, fix }]
	})
}
