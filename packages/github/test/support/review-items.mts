import { withHeader } from '@mesh-flow/code-repository/host'
import { quoteHeader } from '../../src/host/reply-header.mts'
import { verdictField } from '../../src/host/review-verdict.mts'
import type { FakeComment, FakeReview } from './fake-github.mts'

/** `text` under the header that quotes `item`, as a reply on the conversation reads. */
export function replyingTo(item: FakeComment | FakeReview | undefined, text: string): string {
	if (item === undefined) throw new Error('There is no item to reply to.')
	if (!('state' in item)) return withHeader(quoteHeader({ body: item.body, at: item.created_at, url: item.html_url }), text)
	return withHeader(quoteHeader({ body: item.body, at: item.submitted_at, url: item.html_url, ...verdictField(item.state) }), text)
}

/** Comment `comment` of `kind` as `showBeingRead` takes it. */
export function beingRead(kind: 'comment' | 'review-comment', comment: FakeComment | undefined) {
	if (comment === undefined) throw new Error('There is no comment to show as being read.')
	return { id: `${kind}/${String(comment.id)}`, url: comment.html_url, body: comment.body, at: comment.created_at }
}
