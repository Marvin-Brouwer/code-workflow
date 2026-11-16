import { z } from 'zod'

/** A person as Confluence describes them; Cloud leaves out the email of someone who keeps it private. */
export const RawUser = z.object({ displayName: z.string().optional(), email: z.string().optional() })
export type RawUser = z.infer<typeof RawUser>
