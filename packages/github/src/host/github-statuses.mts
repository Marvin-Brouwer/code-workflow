/** A 401 is GitHub's answer to a token it doesn't take. A 403 is not one: a locked conversation answers that too. */
export { goneStatus, notFound, unauthorized, unavailable } from '@mesh-flow/forge/host'

/** GitHub's answer when what was asked for didn't change since the ETag it was sent. */
export const notModified = 304
