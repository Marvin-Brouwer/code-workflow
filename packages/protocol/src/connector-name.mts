import { z } from 'zod'

/** Names a connector, such as `github` or `aws`. Goes into directory names: lowercase letters, digits and dashes. */
export const ConnectorName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Use lowercase letters, digits and dashes.')
export type ConnectorName = z.infer<typeof ConnectorName>
