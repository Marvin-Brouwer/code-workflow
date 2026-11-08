import { z } from 'zod'

/** Names a request within a run. Ends up in a file name in the sandbox, so only safe characters. */
export const RequestId = z.string().regex(/^[\w-]{1,64}$/, 'Use 1 to 64 letters, digits, dashes or underscores.')
export type RequestId = z.infer<typeof RequestId>
