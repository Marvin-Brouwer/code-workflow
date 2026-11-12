import { limit, succeed, type Agent, type Limit } from '@mesh-flow/core'
import { z } from 'zod'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import { ReviewItemId, type PullRequestRef, type ReviewItem } from '../tools/pull-request-tools.mts'

/** What `triage` takes besides the agent and the checkout. */
export interface TriageOptions {
	/** The pull request the items are on. */
	readonly pullRequest: PullRequestRef
	/** The items to sort, as `review` hands them to its `comments` handler. */
	readonly comments: readonly ReviewItem[]
	/** The limit of the loop. Default: 10 minutes. */
	readonly limit?: Limit
}

/** An item that asks for a change, and what the agent said it will do about it. */
export interface PlannedChange {
	readonly item: ReviewItem
	readonly plan: string
}

/** How long the loop may take when the caller sets no limit. */
const defaultLimit = limit({ minutes: 10 })

/** What the agent sorts each item into: a question, a change it will make, or a change it won't make. */
const ItemAsks = z.enum(['question', 'change', 'declined'])

/**
 * Has `agent` sort review items into questions and requests for a change, in one loop that changes
 * nothing. A question, and a change the agent won't make, get the answer as the reply, in place of
 * the "👀 Reading..." reply. A request for a change gets a plan as the reply, what the agent will do
 * about it, and comes back to the caller, which has the work done in a loop of its own and has its
 * answer say what was done. So the reviewer sees each item go from being read, to the plan, to what
 * was done, and a question go from being read to its answer.
 *
 * Code posts the replies, not the agent, once the loop is done. A line comment deleted since it was
 * read is left out. Stopping the run stops the loop and any reply still in flight.
 *
 * ```ts
 * const changes = await github.triage(developer, repository, { pullRequest, comments })
 * ```
 */
export async function triage(agent: Agent, repository: Repository, options: TriageOptions): Promise<readonly PlannedChange[]> {
	const { pullRequest, comments } = options
	if (comments.length === 0) return []
	const sorted = await agent.loop`
		These are new review comments on ${pullRequest}, the pull request of the checkout ${repository}:
		${comments}

		Sort every item: a question, or a request to change something, such as the code, its tests or its docs.
		Read the checkout as much as you need to, and change nothing: the changes are made afterwards.
		For a question, write the answer to it. For a request to change something, write in a few sentences
		what you will change; when you won't change it, sort it as declined and say why. Write it to the reviewer.
		When every item is sorted, ${succeed(triageResult(comments))}.
		${options.limit ?? defaultLimit}
	`
	const sortedById = new Map(sorted.items.map((sortedItem) => [sortedItem.id, sortedItem]))
	const changes: PlannedChange[] = []
	// One at a time and in the reviewer's order: GitHub limits bursts of writes.
	for (const item of comments) {
		const sortedItem = sortedById.get(item.id)
		if (sortedItem === undefined) throw new Error(`The agent left ${item.id} unsorted.`)
		const stage = sortedItem.asks === 'change' ? 'plan' : 'answer'
		const outcome = await stubs.replyToReviewItem({ ...pullRequest, item: item.id, body: sortedItem.reply, stage })
		// A comment deleted since it was read asks for nothing any more.
		if (sortedItem.asks === 'change' && !('gone' in outcome)) changes.push({ item, plan: sortedItem.reply })
	}
	return changes
}

/** What the agent finishes with: every item in `comments`, once, with what it asks for and its reply. */
export function triageResult(comments: readonly ReviewItem[]) {
	const ids = new Set(comments.map((item) => item.id))
	return z
		.object({
			items: z.array(
				z.object({
					id: ReviewItemId.describe('The id of the item, as listed'),
					asks: ItemAsks,
					reply: z.string().min(1).describe('The answer to a question, or what you will do about a request to change something'),
				}),
			),
		})
		.superRefine(({ items }, context) => {
			const given = items.map((sortedItem) => sortedItem.id)
			const missing = [...ids].filter((id) => !given.includes(id))
			const unknown = given.filter((id) => !ids.has(id))
			const twice = given.filter((id, index) => given.indexOf(id) !== index)
			if (missing.length > 0) context.addIssue({ code: 'custom', message: `Sort these items too: ${missing.join(', ')}.` })
			if (unknown.length > 0) context.addIssue({ code: 'custom', message: `These items weren't listed: ${unknown.join(', ')}.` })
			if (twice.length > 0) context.addIssue({ code: 'custom', message: `Sort each item once: ${twice.join(', ')}.` })
		})
}
