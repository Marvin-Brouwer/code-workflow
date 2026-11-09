import { z } from 'zod'

/** A workflow's name, as `workflow()` in `@mesh-flow/core` takes it: lowercase letters, digits and dashes. */
export const WorkflowName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'A workflow name is lowercase letters, digits and dashes.')
