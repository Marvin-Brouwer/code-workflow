import { normalizedBody } from '../describe/change-text.mts'
import { commentMarker, markerValue } from '../markers.mts'
import type { ReplyStage } from '../review/triage-items.mts'
import { answeredKey, plannedKey, reactionKey, reactionKeyName, repliedKey, replyKey, seenKey } from './reply-keys.mts'
import type { OwnReply, ReplyOutcome, ReviewComments } from './review-comments.mts'
import { signed, unsigned } from './signature.mts'

/** A reply to review item `item`, the comment `commentId` of `kind`, as `replyToItem` posts it. */
export interface ReviewReply<Kind extends string> {
	readonly item: string
	readonly kind: Kind
	readonly commentId: number
	readonly body: string
	readonly stage: ReplyStage
	readonly runId: string
}

/**
 * Replies to a review item. A plan takes the place of the "👀 Reading..." reply and keeps the 👀 on
 * the item. An answer takes the place of the reading reply too and takes the 👀 off, unless a plan
 * took that place already: then it's a reply of its own under the plan, since code hosts notify the
 * reviewer of a new comment and not of an edit. A reply that says what one of the item's replies
 * says already is that reply, so a run that starts over doesn't say it twice. A line comment deleted
 * since it was read takes no new reply in its thread: the item is gone.
 */
export async function replyToItem<Kind extends string, Thread>(
	comments: ReviewComments<Kind, Thread>,
	reply: ReviewReply<Kind>,
): Promise<ReplyOutcome> {
	const { item, kind, commentId, body, stage, runId } = reply
	const replies = await comments.ownReplies([kind])
	const withKey = (key: string) => replies.filter((own) => own.body.includes(commentMarker(key)))
	const said = [...withKey(stage === 'plan' ? plannedKey(item) : answeredKey(item)), ...withKey(repliedKey(item))].find((own) =>
		saysTheSame(own, body),
	)
	if (said !== undefined) return { id: said.id, url: said.url }

	const reading = withKey(seenKey(item)).at(0)
	const newReply = async (markerKeys: readonly string[]): Promise<ReplyOutcome> => {
		const thread = await threadOrGone(comments, kind, commentId)
		if (thread === gone) return { gone: true }
		return comments.post(kind, thread, signed(body, runId, [replyKey, ...markerKeys]))
	}
	const reaction = reading === undefined ? undefined : markerValue(reading.body, reactionKeyName)
	const reactionKeys = reaction === undefined ? [] : [reactionKey(Number(reaction))]

	if (stage === 'plan') {
		// The plan keeps the reading reply's markers, so the answer still finds it and the 👀 it put on.
		const keys = [seenKey(item), plannedKey(item), ...reactionKeys]
		if (reading === undefined) return newReply(keys)
		return comments.edit(kind, reading.id, signed(body, runId, [replyKey, ...keys]))
	}
	if (reading === undefined) return newReply([repliedKey(item)])
	// Before the edit, so an answer that fails halfway finds the reading reply again when it's tried once more.
	if (reaction !== undefined) await comments.unreact(kind, commentId, Number(reaction))
	if (!reading.body.includes(commentMarker(plannedKey(item))))
		return comments.edit(kind, reading.id, signed(body, runId, [replyKey, answeredKey(item)]))
	// The plan is marked answered first: an answer that fails halfway is then tried again as a reply of its own.
	await comments.edit(kind, reading.id, signed(unsigned(reading.body), runId, [replyKey, answeredKey(item), plannedKey(item)]))
	return newReply([repliedKey(item)])
}

/** What `threadOrGone` gives for a line comment deleted since it was read. */
const gone = Symbol('gone')

/**
 * The thread a reply to comment `commentId` goes in, or {@link gone} when it was deleted. Only a
 * comment that's gone here means the item is gone: one anywhere else, say on the conversation, is a
 * request that's gone or a token that may not write, and fails.
 */
async function threadOrGone<Kind extends string, Thread>(
	comments: ReviewComments<Kind, Thread>,
	kind: Kind,
	commentId: number,
): Promise<Thread | undefined | typeof gone> {
	try {
		return await comments.threadOf(kind, commentId)
	} catch (error) {
		if (comments.isGone(error)) return gone
		throw error
	}
}

/** Whether one of this package's replies says `body`, whichever run signed it. */
function saysTheSame(own: OwnReply, body: string): boolean {
	return normalizedBody(unsigned(own.body)) === normalizedBody(body)
}
