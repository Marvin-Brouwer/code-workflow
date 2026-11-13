import type { Agent, Limit } from '@mesh-flow/core'
import { describeChange, type DescribeCodeHost } from '@mesh-flow/code-repository'
import { sameProjectPath } from '../project-path.mts'
import type { Repository } from '../repository/repository.mts'
import type { MergeRequestRef } from '../tools/merge-request-tools.mts'
import { branchHead } from './branch-head.mts'
import { gitlabTerms } from './gitlab-terms.mts'
import { gitlabLayout } from './layout.mts'
import { MergeRequestText, type ClosesIssue, type MergeRequestContent } from './merge-request-text.mts'
import { findOpenMergeRequest, mergeRequest, type MergeRequest } from './merge-request.mts'

/** What `describe` takes besides the agent and the checkout. */
export interface DescribeOptions {
	/**
	 * The issue the branch resolves, which the agent reads for the why, and which the result closes.
	 * Pass it again when describing a merge request again, or the `Fixes` line is gone.
	 */
	readonly closes?: ClosesIssue
	/**
	 * The merge request the branch already has, to describe again: the agent starts from its title
	 * and description, for the branch as it was last pushed, and no loop runs when they already
	 * cover that commit. It has to be the merge request of the checkout's branch onto the default branch.
	 */
	readonly mergeRequest?: MergeRequestRef
	/** The limit of the loop. Default: 10 minutes. */
	readonly limit?: Limit
}

/**
 * Has `agent` write the title and description of the merge request for a checkout's branch, in one
 * loop. Code reads what the agent needs first: the branch's commits and diff against the default
 * branch, the project's merge request templates (`.gitlab/merge_request_templates/`), and its
 * settings that lint commit messages or titles, commitlint's or a CI job's; the agent fills a
 * template in, or a default shape when there is none, and keeps to those settings. The description
 * says what the branch changes and why, as it is now: never what happened on the way there. The
 * package ships no agent: the workflow passes its own. Without `mergeRequest`, what is described is
 * what is committed, at the checkout's `HEAD`; a branch without commits of its own is refused. When
 * the branch has an open merge request all the same, the agent starts from its text, and no loop
 * runs when that text already covers `HEAD`.
 *
 * With `mergeRequest`, it describes that merge request again, for after a round of review: the
 * agent rewrites the current text for the branch as it was last pushed. When the text already
 * covers that commit, or the merge request is closed, no loop runs and the current text comes back.
 * A merge request of another branch, or onto another branch than the default one, is refused.
 *
 * Writing the text is up to the caller: the result goes to `openMergeRequest` or
 * `updateMergeRequest` as it is. It stops with the run, as the loop does.
 *
 * ```ts
 * const mergeRequest = await gitlab.openMergeRequest(repository, await gitlab.describe(writer, repository, { closes: story }))
 * ```
 */
export function describe(agent: Agent, repository: Repository, options: DescribeOptions = {}): Promise<MergeRequestContent> {
	return describeChange(agent, repository, gitlabDescribe, {
		...(options.closes === undefined ? {} : { closes: options.closes }),
		...(options.mergeRequest === undefined ? {} : { request: options.mergeRequest }),
		...(options.limit === undefined ? {} : { limit: options.limit }),
	})
}

/** How `describe` reads GitLab. */
const gitlabDescribe: DescribeCodeHost<Repository, MergeRequest, MergeRequestRef> = {
	terms: gitlabTerms,
	layout: gitlabLayout,
	text: MergeRequestText,
	sameRepository: sameProjectPath,
	findOpen: (repository) => findOpenMergeRequest(repository),
	read: (ref) => mergeRequest(ref),
	head: (repository, pushed) => branchHead(repository)({ pushed }),
}
