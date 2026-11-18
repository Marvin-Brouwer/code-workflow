import { loginCommand } from '@mesh-flow/gateway'
import type { ShownSignInPrompt } from './sign-in-state.mts'

/** Where to sign in: the page to open, the code it should show, and until when the code works. */
export function signInPromptLine(prompt: ShownSignInPrompt): string {
	return `open ${prompt.url} and check that it shows ${prompt.code}, until ${new Date(prompt.expiresAt).toLocaleTimeString()}`
}

/** What the engine logs, and `mesh-flow login` shows, once a sign-in has a code. */
export function signInPromptMessage(connector: string, prompt: ShownSignInPrompt): string {
	return `Sign in to ${connector}: ${signInPromptLine(prompt)}.`
}

/** What the engine logs, and `mesh-flow login` shows, when a try of a sign-in failed. */
export function signInFailedLine(connector: string, error: string): string {
	return `Signing in to ${connector} failed, trying again: ${error}`
}

/** The other way to sign in, for `mesh-flow show`. */
export function signInCommandLine(connector: string): string {
	return `or: ${loginCommand(connector)}`
}
