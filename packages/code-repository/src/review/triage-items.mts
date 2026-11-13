import { limit, succeed, type Agent, type Limit } from '@mesh-flow/core'
import { z } from 'zod'
import type { Checkout } from '../checkout/checkout.mts'
import type { CodeHostTerms } from '../describe/change-request.mts'
import { defaultReplyStage, type ReplyStage } from './reply-stage.mts'

/** Something a reviewer said, as `triageItems` needs it: the id an agent replies to. */
export interface TriageItem {
	readonly id: string
}

/** How a code host's connector triages: its names, what its ids look like, and how it replies. */
export interface TriageCodeHost<Item extends TriageItem> {
	readonly terms: CodeHostTerms
	/** The id of an item as an agent sees it, such as `review-comment/12`. */
	readonly itemId: z.ZodType<string>
	/** Replies to an item, in place of the "👀 Reading..." reply. Resolves to whether the item is gone, deleted since it was read. */
	readonly reply: (item: Item, body: string, stage: ReplyStage) => Promise<{ readonly gone: boolean }>
}

/** What `triageItems` takes besides the agent, the checkout and the code host. */
export interface TriageItemsOptions<Item extends TriageItem> {
	/** The pull or merge request the items are on, as it renders in a prompt. */
	readonly request: unknown
	/** The items to sort, as a connector's `review` hands them to its `comments` handler. */
	readonly comments: readonly Item[]
	/** The limit of the loop. Default: 10 minutes. */
	readonly limit?: Limit
}

/** An item that asks for a change, and what the agent said it will do about it. */
export interface PlannedChange<Item extends TriageItem> {
	readonly item: Item
	readonly plan: string
}

/** How long the loop may take when the caller sets no limit. */
const defaultLimit = limit({ minutes: 10 })

/** What the agent sorts each item into: a question, a change it will make, or a change it won't make. */
const ItemAsks = z.enum(['question', 'change', 'declined'])

/**
 * Has `agent` sort review items into questions and requests for a change, in one loop that changes
 * nothing. It answers the questions and the declined changes and puts the plan under each change
 * it will make, which it resolves to. Code posts the replies once the loop is done, one at a time
 * and in the reviewer's order, since code hosts limit bursts of writes.
 */
export async function triageItems<Item extends TriageItem>(
	agent: Agent,
	repository: Checkout,
	codeHost: TriageCodeHost<Item>,
	options: TriageItemsOptions<Item>,
): Promise<readonly PlannedChange<Item>[]> {
	const { comments } = options
	if (comments.length === 0) return []
	const sorted = await sortItems(agent, repository, codeHost.terms, codeHost.itemId, options)
	const sortedById = new Map(sorted.items.map((sortedItem) => [sortedItem.id, sortedItem]))
	const changes: PlannedChange<Item>[] = []
	for (const item of comments) {
		const sortedItem = sortedById.get(item.id)
		if (sortedItem === undefined) throw new Error(`The agent left ${item.id} unsorted.`)
		const { gone } = await codeHost.reply(item, sortedItem.reply, sortedItem.asks === 'change' ? 'plan' : defaultReplyStage)
		// A comment deleted since it was read asks for nothing any more.
		if (sortedItem.asks === 'change' && !gone) changes.push({ item, plan: sortedItem.reply })
	}
	return changes
}

/** The loop itself: the agent sorts every item and writes its reply. */
function sortItems(
	agent: Agent,
	repository: Checkout,
	terms: CodeHostTerms,
	itemId: z.ZodType<string>,
	options: TriageItemsOptions<TriageItem>,
): Promise<z.infer<ReturnType<typeof triageResult>>> {
	const { request, comments } = options
	return agent.loop`
		These are new review comments on ${request}, the ${terms.request} of the checkout ${repository}:
		${comments}

		Sort every item: a question, or a request to change something, such as the code, its tests or its docs.
		Read the checkout as much as you need to, and change nothing: the changes are made afterwards.
		For a question, write the answer to it. For a request to change something, write in a few sentences
		what you will change; when you won't change it, sort it as declined and say why. Write it to the reviewer.
		When every item is sorted, ${succeed(triageResult(comments, itemId))}.
		${options.limit ?? defaultLimit}
	`
}

/** What the agent finishes with: every item in `comments`, once, with what it asks for and its reply. */
export function triageResult(comments: readonly TriageItem[], itemId: z.ZodType<string>) {
	const ids = new Set(comments.map((item) => item.id))
	return z
		.object({
			items: z.array(
				z.object({
					id: itemId.describe('The id of the item, as listed'),
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
