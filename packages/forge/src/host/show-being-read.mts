import { isTransient } from '@mesh-flow/gateway'
import { commentMarker } from '../markers.mts'
import { answeredKey, reactionKey, repliedKey, replyKey, seenKey } from './reply-keys.mts'
import type { ReviewComments } from './review-comments.mts'
import { signed } from './signature.mts'

/** A review item to show as being read, in the terms of the forge's {@link ReviewComments}. */
export interface ItemBeingRead<Kind extends string, Thread> {
	/** The item's id, as the review tools name it. */
	readonly item: string
	readonly kind: Kind
	readonly commentId: number
	/** The text of the reading reply. */
	readonly note: string
	/** The thread the reading reply goes in, or undefined for the conversation. */
	readonly thread: () => Promise<Thread | undefined>
}

/** Options of {@link showItemsBeingRead}. */
export interface ShowBeingReadOptions {
	/** The run whose footer signs the reading replies. */
	readonly runId: string
	readonly abortSignal: AbortSignal
	/** Whether an error, besides one that may pass, says something is wrong with the call rather than with one item, such as a refused token. */
	readonly failsCall: (error: unknown) => boolean
}

/** Which items were shown as being read, and which had an answer already. */
export interface ShownBeingRead {
	readonly shown: readonly string[]
	readonly answered: readonly string[]
}

/**
 * Puts 👀 on each item and a signed reading reply under it, once: an item with a reading reply
 * already keeps it, and one with an answer is left as it is. An item that can't be shown, such as
 * one deleted since it was read or in a locked conversation, is left out. An error that may pass,
 * a stopped call or one `failsCall` takes fails the call, since none of them says the items were shown.
 */
export async function showItemsBeingRead<Kind extends string, Thread>(
	comments: ReviewComments<Kind, Thread>,
	items: readonly ItemBeingRead<Kind, Thread>[],
	{ runId, abortSignal, failsCall }: ShowBeingReadOptions,
): Promise<ShownBeingRead> {
	const replies = await comments.ownReplies([...new Set(items.map((listed) => listed.kind))])
	const hasReply = (key: string) => replies.some((reply) => reply.body.includes(commentMarker(key)))
	const shown: string[] = []
	const answered: string[] = []
	// One at a time: forges limit bursts of writes, and a round of review can bring many items.
	for (const { item, kind, commentId, note, thread } of items) {
		// An answer replaced the reading reply, or is a reply of its own when there was none.
		if (hasReply(answeredKey(item)) || hasReply(repliedKey(item))) {
			answered.push(item)
			continue
		}
		try {
			const reaction = await comments.react(kind, commentId)
			if (!hasReply(seenKey(item))) {
				const reactionKeys = reaction === undefined ? [] : [reactionKey(reaction)]
				await comments.post(kind, await thread(), signed(note, runId, [replyKey, seenKey(item), ...reactionKeys]))
			}
			shown.push(item)
		} catch (error) {
			if (isTransient(error) || abortSignal.aborted || failsCall(error)) throw error
		}
	}
	return { shown, answered }
}
