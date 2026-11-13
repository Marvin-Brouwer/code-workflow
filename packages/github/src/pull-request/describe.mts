import type { Agent, Limit } from '@mesh-flow/core'
import { describeChange, type DescribeForge } from '@mesh-flow/forge'
import type { Issue } from '../issue/issue.mts'
import { sameRepositoryName } from '../repository-name.mts'
import type { Repository } from '../repository/repository.mts'
import type { PullRequestRef } from '../tools/pull-request-tools.mts'
import { branchHead } from './branch-head.mts'
import { githubTerms } from './github-terms.mts'
import { PullRequestText, type PullRequestContent } from './pull-request-text.mts'
import { findOpenPullRequest, pullRequest, type PullRequest } from './pull-request.mts'
import { githubLayout } from './layout.mts'

/** What `describe` takes besides the agent and the checkout. */
export interface DescribeOptions {
	/**
	 * The issue the branch resolves, which the agent reads for the why, and which the result closes.
	 * Pass it again when describing a pull request again, or the `Fixes` line is gone.
	 */
	readonly issue?: Issue
	/**
	 * The pull request the branch already has, to describe again: the agent starts from its title
	 * and description, for the branch as it was last pushed, and no loop runs when they already
	 * cover that commit. It has to be the pull request of the checkout's branch onto the default branch.
	 */
	readonly pullRequest?: PullRequestRef
	/** The limit of the loop. Default: 10 minutes. */
	readonly limit?: Limit
}

/**
 * Has `agent` write the title and description of the pull request for a checkout's branch, in one
 * loop. Code reads what the agent needs first: the branch's commits and diff against the default
 * branch, the repository's pull request template, and its settings that lint commit messages or
 * pull request titles; the agent fills the template in, or a default shape when there is none, and
 * keeps to those settings. The description says what the branch changes and why, as it is now:
 * never what happened on the way there. The package ships no agent: the workflow passes its own.
 * Without `pullRequest`, what is described is what is committed, at the checkout's `HEAD`; a
 * branch without commits of its own is refused. When the branch has an open pull request all the
 * same, as when a run starts over after a round of review, the agent starts from its text, and no
 * loop runs when that text already covers `HEAD`.
 *
 * With `pullRequest`, it describes that pull request again, for after a round of review: the agent
 * rewrites the current text for the branch as it was last pushed. When the text already covers
 * that commit, or the pull request is closed, no loop runs and the current text comes back, so
 * calling it after every round costs a read of the pull request and of the branch's commit. A pull
 * request of another branch, or onto another branch than the default one, is refused.
 *
 * Writing the text is up to the caller: the result, which closes `issue`, goes to `openPullRequest`
 * or `updatePullRequest` as it is. It names the pull request and the text it was written from, so
 * a person who edited the pull request meanwhile is asked before their edit is overwritten.
 *
 * It stops with the run, as the loop does: an agent's loop follows the run's signal, not one of
 * the caller's.
 *
 * ```ts
 * const pullRequest = await github.openPullRequest(repository, await github.describe(writer, repository, { issue }))
 * // After a round of review:
 * await github.updatePullRequest(pullRequest, await github.describe(writer, repository, { issue, pullRequest }))
 * ```
 */
export async function describe(agent: Agent, repository: Repository, options: DescribeOptions = {}): Promise<PullRequestContent> {
	return describeChange(agent, repository, githubDescribe, {
		...(options.issue === undefined ? {} : { closes: options.issue }),
		...(options.pullRequest === undefined ? {} : { request: options.pullRequest }),
		...(options.limit === undefined ? {} : { limit: options.limit }),
	})
}

/** How `describe` reads GitHub. */
const githubDescribe: DescribeForge<Repository, PullRequest, PullRequestRef> = {
	terms: githubTerms,
	layout: githubLayout,
	text: PullRequestText,
	sameRepository: sameRepositoryName,
	findOpen: (repository) => findOpenPullRequest(repository),
	read: (ref) => pullRequest(ref),
	head: (repository, pushed) => branchHead(repository)({ pushed }),
}
