import { z } from 'zod'

/** A sign-in under way, as `mesh-flow show` and `mesh-flow login` show it. */
export const SignInState = z.object({
	connector: z.string(),
	/** Where to sign in, once the service handed out a code. */
	prompt: z.object({ url: z.string(), code: z.string(), expiresAt: z.iso.datetime() }).optional(),
	/** Why the last try failed, when it did. Another one follows. */
	error: z.string().optional(),
})
export type SignInState = z.infer<typeof SignInState>
