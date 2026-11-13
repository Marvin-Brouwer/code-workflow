import { changeTextSchema, type ChangeContent } from '@mesh-flow/forge'
import type { z } from 'zod'
import type { IssueRef } from '../issue/issue.mts'

/** The longest title GitHub takes. */
const maxTitleCharacters = 256

/** The longest body GitHub takes. */
const maxDescriptionCharacters = 65_536

/**
 * What a pull request says: its title and its description, as the agent of `describe` writes them,
 * within GitHub's limits, less the room for the footer.
 */
export const PullRequestText = changeTextSchema({
	maxTitleCharacters,
	maxDescriptionCharacters,
	request: 'pull request',
})
export type PullRequestText = z.infer<typeof PullRequestText>

/**
 * What a pull request is opened or updated with: its text, the commit the text was written for and
 * the issue it closes, for which `Fixes` goes in the footer. `describe` resolves to one, ready for
 * `openPullRequest` or `updatePullRequest`.
 */
export type PullRequestContent = ChangeContent<IssueRef>
