import { z } from 'zod'
import type { IssueRef } from '../issue/issue.mts'
import { fenced } from './fenced.mts'

/** GitHub's longest pull request title. */
const maxTitleCharacters = 256

/** GitHub's longest pull request body, less room for the footer the connector adds. */
const maxDescriptionCharacters = 60_000

/**
 * What a pull request says: its title and its description, as the agent of `describe` writes them.
 * Within GitHub's limits, so a text that is too long goes back to the agent rather than failing
 * the run on GitHub, and on every rerun after, since the loop keeps its result.
 */
export const PullRequestText = z.object({
	title: z
		.string()
		.min(1)
		.max(maxTitleCharacters)
		.regex(/^[^\r\n]+$/, 'Write the title on one line.')
		.describe("The pull request's title, one line"),
	description: z.string().min(1).max(maxDescriptionCharacters).describe("The pull request's description, in Markdown"),
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
	/**
	 * The pull request the new text was written from, and what it said then. `openPullRequest`
	 * updates that one rather than open another. When it says something else by the time the text is
	 * written, someone edited it meanwhile, and the person is asked before the edit is overwritten.
	 */
	readonly basedOn?: BasedOn
}

/** The pull request a text was written from, by repository and number, and its title and description then. */
export interface BasedOn extends PullRequestText {
	readonly repository: string
	readonly number: number
}

/** Whether two texts say the same. */
export function sameText(one: PullRequestText, other: PullRequestText): boolean {
	return one.title === other.title && one.description === other.description
}

/** A pull request's title and description as a prompt takes them, the description fenced. */
export function textInPrompt(text: PullRequestText): string {
	return `Title: ${text.title}\nDescription:\n${fenced(text.description)}`
}
