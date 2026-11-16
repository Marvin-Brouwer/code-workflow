import { z } from 'zod'

/**
 * Makes sure the host can reach AWS: answers once it can, and when the user has to sign in first,
 * the run waits for that sign-in, as for any AWS tool.
 */
export const checkSession = {
	name: 'awsCheckSession',
	description:
		'Makes sure there is an AWS session, for before a long stretch of work that needs AWS. When there is none, waits until the user has signed in.',
	input: z.object({}),
	output: z.object({ signedIn: z.literal(true) }),
}
