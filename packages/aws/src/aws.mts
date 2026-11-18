import { hostToolStub } from '@mesh-flow/core'
import { checkSession as checkSessionDefinition } from './tools/check-session.mts'

/**
 * Makes sure there is an AWS session, as a function and as a tool. It answers once the host can
 * reach AWS; without a session, the run waits for the user to sign in (`mesh-flow login aws`, or
 * the URL `mesh-flow show <run>` gives), as it does for any AWS tool. Nothing has to call it
 * first: it's for code that wants to know up front, such as before a long unattended stretch.
 *
 * ```ts
 * await aws.checkSession({})
 * ```
 */
export const checkSession = hostToolStub(checkSessionDefinition)
