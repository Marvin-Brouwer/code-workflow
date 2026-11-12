import { toPrompt, type RendersInPrompt } from '@mesh-flow/core'
import { z } from 'zod'
import type { IssueRef } from '../issue/issue.mts'
import { fenced } from './fenced.mts'

/** What a pull request says: its title and its description, as the agent of `describe` writes them. */
export const PullRequestText = z.object({
	title: z.string().min(1).describe("The pull request's title, one line"),
	description: z.string().min(1).describe("The pull request's description, in Markdown"),
})
export type PullRequestText = z.infer<typeof PullRequestText>

/**
 * What a pull request is opened or updated with: its text, the commit the text was written for and
 * the issue it closes. `describe` resolves to one, ready for `openPullRequest` or `updatePullRequest`.
 */
export interface PullRequestContent extends PullRequestText {
	/** The commit the description was written for. Default for `openPullRequest`: the pushed head. */
	readonly describedSha?: string
	/** The issue the pull request closes when it merges: `Fixes` goes in the footer, next to the run id. */
	readonly closes?: IssueRef
}

/** A pull request's title and description as a prompt takes them, the description fenced. */
export function textInPrompt(text: PullRequestText): RendersInPrompt {
	return Object.freeze({ [toPrompt]: () => `Title: ${text.title}\nDescription:\n${fenced(text.description)}` })
}
