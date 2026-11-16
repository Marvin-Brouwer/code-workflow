import type { LoginPrompt } from '@mesh-flow/gateway'

/** The lines that tell the user where to sign in. */
export function formatLoginPrompt(connector: string, prompt: LoginPrompt): string {
	return [
		`Sign in to ${connector}: open ${prompt.url}`,
		`and check that it shows ${prompt.code}. The code works until ${prompt.expiresAt.toLocaleTimeString()}.`,
	].join('\n')
}
