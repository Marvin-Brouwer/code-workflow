import type { CredentialReader, WantedCredential } from '@mesh-flow/gateway'

/**
 * The names the AWS connector uses in the gateway's credential store. The first four are settings,
 * which the user sets with `mesh-flow credential set` until the settings UI takes them over; the
 * last is what signing in keeps.
 */
export const awsCredentialNames = Object.freeze({
	/** The AWS access portal of the Identity Center instance, such as `https://example.awsapps.com/start`. */
	startUrl: 'aws/start-url',
	/** The region the Identity Center instance is in, such as `eu-west-1`. */
	ssoRegion: 'aws/sso-region',
	/** The AWS account the role is in. */
	account: 'aws/account',
	/** The permission set's role to work with, such as `Developer`. */
	role: 'aws/role',
	/** The Identity Center session: its client registration, access token and refresh token. */
	session: 'aws/session',
})

/** Where the user signs in, and the role the session works with. None of it is secret. */
export interface AwsSettings {
	readonly startUrl: string
	readonly ssoRegion: string
	readonly account: string
	readonly role: string
}

/** An example value for each setting, for the error that asks for it. */
const settingExamples: Readonly<Record<keyof AwsSettings, string>> = {
	startUrl: 'https://example.awsapps.com/start',
	ssoRegion: 'eu-west-1',
	account: '123456789012',
	role: 'Developer',
}

/** The settings, in the order the error lists them. */
const settingKeys = ['startUrl', 'ssoRegion', 'account', 'role'] as const satisfies readonly (keyof AwsSettings)[]

/** The settings as the credentials that hold them, with an example of each, for a settings check. */
export const awsSettingCredentials: readonly WantedCredential[] = settingKeys.map((key) => ({
	name: awsCredentialNames[key],
	example: settingExamples[key],
}))

/**
 * The AWS settings from the credential store.
 *
 * @throws When any is missing, naming each with the command that sets it.
 */
export async function readAwsSettings(credentials: CredentialReader, abortSignal: AbortSignal): Promise<AwsSettings> {
	const [startUrl, ssoRegion, account, role] = await Promise.all(
		settingKeys.map((key) => credentials.get(awsCredentialNames[key], abortSignal)),
	)
	if (startUrl !== undefined && ssoRegion !== undefined && account !== undefined && role !== undefined)
		return { startUrl, ssoRegion, account, role }
	const found: Readonly<Record<keyof AwsSettings, string | undefined>> = { startUrl, ssoRegion, account, role }
	const commands = settingKeys
		.filter((key) => found[key] === undefined)
		.map((key) => `  echo '${settingExamples[key]}' | mesh-flow credential set ${awsCredentialNames[key]}`)
	throw new Error(`AWS isn't set up. Set:\n${commands.join('\n')}`)
}

/** The settings as one string, to tell which settings something was fetched for. */
export function settingsKey(settings: AwsSettings): string {
	return JSON.stringify(settingKeys.map((key) => settings[key]))
}
