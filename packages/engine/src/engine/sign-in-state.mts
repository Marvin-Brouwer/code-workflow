import type { SignInPrompt } from '@mesh-flow/gateway'
import { z } from 'zod'

/** Where to sign in, as the engine keeps and serves it: a connector's `SignInPrompt`, with its end as an ISO time. */
export const ShownSignInPrompt = z.object({ url: z.string(), code: z.string(), expiresAt: z.iso.datetime() })
export type ShownSignInPrompt = z.infer<typeof ShownSignInPrompt>

/** The prompt a connector handed out, as the engine keeps it. */
export function shownSignInPrompt(prompt: SignInPrompt): ShownSignInPrompt {
	return { url: prompt.url, code: prompt.code, expiresAt: prompt.expiresAt.toISOString() }
}

/** A sign-in under way, as `mesh-flow show` and `mesh-flow login` show it. */
export const SignInState = z.object({
	connector: z.string(),
	/** Where to sign in, once the service handed out a code. */
	prompt: ShownSignInPrompt.optional(),
	/** Why the last try failed, when it did. Another one follows. */
	error: z.string().optional(),
})
export type SignInState = z.infer<typeof SignInState>
