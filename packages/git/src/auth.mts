/**
 * The environment that makes git send a Basic authorization header to HTTPS remotes. Through
 * `GIT_CONFIG_*`, so the credential is neither in the arguments nor in `.git/config`, and with
 * the credential helper off, so git never asks for or stores anything else.
 */
export function basicAuthHeaderEnv(username: string, token: string): Record<string, string> {
	const authorization = Buffer.from(`${username}:${token}`).toString('base64')
	return {
		GIT_CONFIG_COUNT: '2',
		GIT_CONFIG_KEY_0: 'http.extraHeader',
		GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
		GIT_CONFIG_KEY_1: 'credential.helper',
		GIT_CONFIG_VALUE_1: '',
	}
}
