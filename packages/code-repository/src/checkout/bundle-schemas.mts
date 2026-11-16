import { z } from 'zod'

/** A git bundle, base64: how commits cross between the host and the sandbox without a credential. */
export const Bundle = z.base64()

/** A commit id. */
export const Sha = z.string().regex(/^[0-9a-f]{40}$/)
