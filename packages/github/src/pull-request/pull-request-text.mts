import { z } from 'zod'

/** What a pull request says: its title and its description, as an agent writes them with `describe`. */
export const PullRequestText = z.object({
	title: z.string().min(1).describe("The pull request's title, one line"),
	description: z.string().min(1).describe("The pull request's description, in Markdown"),
})
export type PullRequestText = z.infer<typeof PullRequestText>
