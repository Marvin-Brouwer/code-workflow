/**
 * What the connectors of code hosts share on the host's side: clones that fetch and push with the
 * credential, requests tried again when the connection drops, one call at a time per key, and the
 * footer every post is signed with.
 *
 * @module
 */
export { gitRemote, type GitRemote, type GitRemoteOptions } from '../host/git-remote.mts'
export { gitHostTools } from '../host/git-host-tools.mts'
export { gone, notFound, unauthorized, unavailable } from '../host/http-statuses.mts'
export { defaultFetchRetry, retryingFetch, type FetchRetryOptions } from '../host/retrying-fetch.mts'
export { runIdLine, signed, unsigned, withoutRunId } from '../host/signature.mts'
export { withUnixLineBreaks } from '../line-breaks.mts'
export { descriptionOf, footerCloses, sameBody, signedDescription, type DescriptionNotes } from '../host/description.mts'
export { answeredKey, plannedKey, reactionKey, reactionKeyName, repliedKey, replyKey, seenKey } from '../host/reply-keys.mts'
export type { OwnReply, PostedReply, ReplyOutcome, ReviewComments } from '../host/review-comments.mts'
export { replyToItem, type ReviewReply } from '../host/review-reply.mts'
export { showItemsBeingRead, type ItemBeingRead, type ShowBeingReadOptions, type ShownBeingRead } from '../host/show-being-read.mts'
export { later } from '../host/later.mts'
