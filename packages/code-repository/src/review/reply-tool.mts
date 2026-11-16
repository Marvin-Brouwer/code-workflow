import { tool, type Tool, type ToolContext } from '@mesh-flow/core'
import { z } from 'zod'
import { ReplyStage } from './reply-stage.mts'

/** What the agent replies with: the item, the text, and whether it's a plan or the answer. */
export interface ReplyInput {
	readonly item: string
	readonly text: string
	readonly stage?: ReplyStage | undefined
}

/** A reply as the agent gave it, for the connector's host tool to post. */
export interface AgentReply {
	readonly item: string
	readonly body: string
	readonly stage?: ReplyStage
}

/** What `replyTool` makes a connector's `reply` from. */
export interface ReplyToolOptions<Outcome> {
	/** The pull or merge request, as the tool's description names it, such as `merge request team/api!7`. */
	readonly on: string
	/** The ids of the code host's review items, such as `note/12`. */
	readonly item: z.ZodType<string>
	/** Posts the reply, through the connector's host tool. */
	readonly replyToReviewItem: (reply: AgentReply, context: ToolContext) => Promise<Outcome>
}

/**
 * The tool a connector's `reply` gives an agent, to reply to a review item in the item's thread.
 * With `stage: 'plan'` the reply says what will be done; the answer, what was done, follows.
 */
export function replyTool<Outcome>(options: ReplyToolOptions<Outcome>): Tool<ReplyInput, Outcome> {
	return tool('reply', {
		description: `Replies to a review item on ${options.on}`,
		input: z.object({
			item: options.item.describe('The id of the item, as listed'),
			text: z.string().min(1),
			stage: ReplyStage.optional().describe(
				'plan: what you will do about the item, before you change anything. answer (the default): the answer to a question, or what you did.',
			),
		}),
		action: ({ item, text, stage }, context) =>
			options.replyToReviewItem({ item, body: text, ...(stage === undefined ? {} : { stage }) }, context),
	})
}
