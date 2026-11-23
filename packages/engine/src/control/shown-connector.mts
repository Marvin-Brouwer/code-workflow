import { z } from 'zod'

/** A connector the engine loaded, as the control API shows it: its name, its package, and whether it signs in. */
export const ShownConnector = z.object({ name: z.string(), package: z.string(), signsIn: z.boolean() })
export type ShownConnector = z.infer<typeof ShownConnector>
