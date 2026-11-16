import { wait, type WaitSpec } from '@mesh-flow/core'
import { defaultLookEvery, defaultToleratedOutage } from './look-interval.mts'
import { patientLook } from './patient-look.mts'

/** A pull or merge request as a watch reads it: whether it's still open, and which commit it's at. */
export interface WatchedRequest {
	readonly state: 'open' | 'closed'
	readonly merged: boolean
	readonly head: { readonly sha: string }
}

/** What a look at a request's review brings: the items since the last look, and the moment to look from next time. */
export interface ReviewActivity<Item> {
	readonly items: readonly Item[]
	/** The latest moment seen, which the next look lists from, inclusive. */
	readonly until?: string | undefined
}

/** How far the checks or the pipeline of a commit are, and what failed. */
export interface CommitChecks<Failure> {
	readonly status: 'none' | 'pending' | 'completed'
	readonly failures: readonly Failure[]
}

/** How a code host's connector looks at one request for `watchReview`. Each look is tried again when it fails, for a while. */
export interface ReviewWatch<Request extends WatchedRequest, Item extends { readonly id: string }, Failure> {
	readonly read: () => Promise<Request>
	readonly activity: (since: string | undefined) => Promise<ReviewActivity<Item>>
	/** Shows the reviewer that the items are being read. Resolves to the ids of those the run answered already. */
	readonly showBeingRead: (items: readonly Item[]) => Promise<{ readonly answered: readonly string[] }>
	readonly checks: (sha: string) => Promise<CommitChecks<Failure>>
}

/** What `watchReview` calls as the review goes on. Each handler finishes before the next event is looked at. */
export interface WatchHandlers<Request, Item, Failure> {
	/** New items, coalesced per look, oldest first, each shown as being read first. */
	readonly comments?: (comments: readonly Item[]) => Promise<unknown>
	/** The checks of a commit came out failed. Once per commit. */
	readonly failed?: (request: Request, sha: string, failures: readonly Failure[]) => Promise<unknown>
}

/** How often `watchReview` looks, and how long looks may keep failing. */
export interface WatchOptions {
	/** How long to wait between looks. Default: 10 seconds. */
	readonly every?: WaitSpec
	/** How long looks may keep failing with errors that may pass. Default: 10 minutes. */
	readonly toleratedOutage?: WaitSpec
}

/** How a watched review ended. */
export interface WatchOutcome<Request> {
	readonly state: 'merged' | 'closed'
	readonly request: Request
}

/**
 * Watches a pull or merge request until it's merged or closed, and calls the handlers as things
 * happen on it: new review items, each shown as being read first, and failed checks of a new
 * head commit, once per commit. The checks are looked at only on a look that handed no items, so
 * a head that a handler replaced is never reported. The wait between looks is on the engine's
 * clock, where the run can be paused.
 */
export async function watchReview<Request extends WatchedRequest, Item extends { readonly id: string }, Failure>(
	watch: ReviewWatch<Request, Item, Failure>,
	handlers: WatchHandlers<Request, Item, Failure>,
	options: WatchOptions = {},
): Promise<WatchOutcome<Request>> {
	const every = options.every ?? defaultLookEvery
	const look = patientLook({ every, toleratedOutage: options.toleratedOutage ?? defaultToleratedOutage })
	let since: string | undefined
	// Activity is listed from the latest moment seen, inclusive, so an item at that second comes again.
	const handled = new Set<string>()
	const reportedChecks = new Set<string>()
	for (;;) {
		const current = await look(watch.read)
		if (current.state === 'closed') return { state: current.merged ? 'merged' : 'closed', request: current }

		const activity = await look(() => watch.activity(since))
		since = activity.until ?? since
		const comments = activity.items.filter((item) => !handled.has(item.id))
		for (const item of comments) handled.add(item.id)
		let handedComments = false
		if (comments.length > 0 && handlers.comments !== undefined) {
			const { answered } = await look(() => watch.showBeingRead(comments))
			// Answered before the run started over: the reviewer has the answer already, and writes a new comment if it doesn't settle it.
			const unanswered = comments.filter((item) => !answered.includes(item.id))
			if (unanswered.length > 0) await handlers.comments(unanswered)
			handedComments = unanswered.length > 0
		}

		// A handler that ran may have pushed, which replaces the head read before it, and a code host may cancel
		// that head's pipeline for it: its checks wait for the next look, which reads the head again.
		if (handlers.failed !== undefined && !handedComments && !reportedChecks.has(current.head.sha)) {
			const checks = await look(() => watch.checks(current.head.sha))
			if (checks.status === 'completed') {
				reportedChecks.add(current.head.sha)
				if (checks.failures.length > 0) await handlers.failed(current, current.head.sha, checks.failures)
			}
		}

		await wait(every)
	}
}
