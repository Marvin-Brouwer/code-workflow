import { z } from 'zod'
import { markerStart } from './markers.mts'

/**
 * The body of a comment that a connector didn't write: every comment it posts, such as a reply to
 * a reviewer, carries a marker. It is a regex pattern rather than a refine, so it is in the JSON
 * Schema the engine checks: the engine skips a connector's own comments before it makes a sandbox,
 * and a workflow that answers comments isn't started again by its answers. The marker holds no
 * regex special characters, so it goes into the pattern as it is.
 *
 * A person who quotes a connector's comment copies its marker, so their comment is skipped too.
 *
 * @example A comment event that leaves out the connector's own comments
 * ```ts
 * const noteCreated = z.object({ object_attributes: z.object({ note: NotByConnector }) })
 * ```
 */
export const NotByConnector = z.string().regex(new RegExp(`^(?![\\s\\S]*${markerStart})`))
