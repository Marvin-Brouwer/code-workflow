import { z } from 'zod'

/** What a pull request says: its title and its description, as the agent of `describe` writes them. */
export const PullRequestText = z.object({
	title: z.string().min(1).describe("The pull request's title, one line"),
	description: z.string().min(1).describe("The pull request's description, in Markdown"),
})
export type PullRequestText = z.infer<typeof PullRequestText>

/** What `describe` resolves to: the text, and the commit of the checkout it was written for. */
export interface PullRequestDescription extends PullRequestText {
	readonly describes: string
}
