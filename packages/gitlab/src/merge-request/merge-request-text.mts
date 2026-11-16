import { changeTextSchema, type ChangeContent } from '@mesh-flow/code-repository'
import type { z } from 'zod'
import { gitlabTerms } from './gitlab-terms.mts'

/** The longest title GitLab takes. */
const maxTitleCharacters = 255

/** The longest description GitLab takes: a mebibyte's worth of characters. */
const maxDescriptionCharacters = 1_048_576

/**
 * What a merge request says: its title and its description, as the agent of `describe` writes them,
 * within GitLab's limits, less the room for the footer. A zod schema, for an agent of your own that
 * writes the text with `succeed(gitlab.MergeRequestText)`, or to check text code wrote.
 *
 * @example
 * ```ts
 * const text = await writer.loop`Write the merge request for ${repository} in the team's style, then ${succeed(gitlab.MergeRequestText)}.`
 * const mergeRequest = await gitlab.openMergeRequest(repository, { ...text, closes: story })
 * ```
 */
export const MergeRequestText = changeTextSchema({
	maxTitleCharacters,
	maxDescriptionCharacters,
	terms: gitlabTerms,
})
export type MergeRequestText = z.infer<typeof MergeRequestText>

/**
 * What a merge request closes when it merges, by its key: a Jira issue, such as one
 * `@mesh-flow/atlassian` collected, with GitLab's Jira integration on. In a prompt it renders as
 * the value does, so the agent of `describe` can read it.
 */
export interface ClosesIssue {
	readonly key: string
}

/**
 * What a merge request is opened or updated with: its text, the commit the text was written for and
 * the issue it closes, for which `Fixes` goes in the footer. `describe` resolves to one, ready for
 * `openMergeRequest` or `updateMergeRequest`.
 */
export type MergeRequestContent = ChangeContent<ClosesIssue>
