import { z } from 'zod'

/**
 * Why an update of a change request wrote nothing. `closed`: a closed one keeps its text.
 * `unchanged`: it already said this. `edited`: someone edited it since it was last looked at.
 */
export const UpdateSkip = z.enum(['closed', 'unchanged', 'edited'])
export type UpdateSkip = z.infer<typeof UpdateSkip>
