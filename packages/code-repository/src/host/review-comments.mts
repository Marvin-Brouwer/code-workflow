/** A reply a connector posted on a pull or merge request. */
export interface OwnReply {
	readonly id: number
	readonly body: string
	readonly url: string
}

/** A comment that was posted or edited. */
export interface PostedReply {
	readonly id: number
	readonly url: string
}

/** What came of a reply: the comment posted or edited, or that the item is gone, deleted since it was read. */
export type ReplyOutcome = PostedReply | { readonly gone: true }

/**
 * Where a connector answers review items on one pull or merge request. `Kind` is the kind of the
 * item answered, which may decide where its replies go, and `Thread` names a thread replies go to.
 */
export interface ReviewComments<Kind extends string, Thread> {
	/** The replies the connector posted where items of `kinds` are answered. */
	readonly ownReplies: (kinds: readonly Kind[]) => Promise<readonly OwnReply[]>
	/** Puts 👀 on comment `commentId` and returns the reaction's id, when the code host takes one on such an item. */
	readonly react: (kind: Kind, commentId: number) => Promise<number | undefined>
	/** Takes reaction `reaction` off comment `commentId`. One that's gone already is fine. */
	readonly unreact: (kind: Kind, commentId: number, reaction: number) => Promise<void>
	/**
	 * The thread a reply to comment `commentId` goes in, or undefined when replies to `kind` go on
	 * the conversation. Throws an error `isGone` takes when the comment was deleted.
	 */
	readonly threadOf: (kind: Kind, commentId: number) => Promise<Thread | undefined>
	/** Whether an error says what was asked for is gone, such as a comment deleted since. */
	readonly isGone: (error: unknown) => boolean
	/** Replies in thread `thread`, or on the conversation. */
	readonly post: (kind: Kind, thread: Thread | undefined, body: string) => Promise<PostedReply>
	/** Replaces the body of the connector's reply `commentId`, where `kind` is answered. */
	readonly edit: (kind: Kind, commentId: number, body: string) => Promise<PostedReply>
}
