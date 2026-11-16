import { quoteHeader } from '../../src/host/reply-quote.mts'
import type { FakeComment, FakeReview } from './fake-github.mts'

/** `text` under the header that quotes `item`, as a reply on the conversation starts. */
export function replyingTo(item: FakeComment | FakeReview | undefined, text: string): string {
	if (item === undefined) throw new Error('There is no item to reply to.')
	const quoted =
		'state' in item
			? { body: item.body, at: item.submitted_at, url: item.html_url, state: item.state }
			: { body: item.body, at: item.created_at, url: item.html_url }
	return `${quoteHeader(quoted)}${text}`
}
