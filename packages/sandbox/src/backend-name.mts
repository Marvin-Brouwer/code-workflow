import { z } from 'zod'

/** The backends this package has. */
export const BackendName = z.enum(['e2b', 'microsandbox', 'gvisor'])
export type BackendName = z.infer<typeof BackendName>
