import { limit, prompt, succeed, type Agent, type Limit, type Prompt, type ToolContext } from '@mesh-flow/core'
import type { Issue } from '../issue/issue.mts'
import type { Repository } from '../repository/repository.mts'
import { stubs } from '../stubs.mts'
import type { PullRequestRef } from '../tools/pull-request-tools.mts'
import { brief, type PullRequestBrief } from './brief.mts'
import { pullRequestOf, withClosingReference, type PullRequest } from './pull-request.mts'
import { PullRequestText } from './pull-request-text.mts'
import { filesInPrompt } from './repository-files.mts'

/** What `describe` takes besides the agent and the checkout. */
export interface DescribeOptions {
	/** The issue the branch resolves, which the agent reads for the why. */
	readonly issue?: Issue
	/** The limit of the loop. Default: 10 minutes. */
	readonly limit?: Limit
}

const defaultLimit = limit({ minutes: 10 })

/**
 * Has `agent` write the title and description of the pull request for a checkout's branch, in one
 * loop. Code reads what the agent needs first: the branch's commits and diff against the default
 * branch, the repository's pull request template, and its settings that lint commit messages or
 * pull request titles; the agent fills the template in, or a default shape when there is none, and
 * keeps to those settings. The description says what the branch changes and why, as it is now:
 * never what happened on the way there. The package ships no agent: the workflow passes its own.
 *
 * ```ts
 * const text = await github.describe(writer, repository, { issue })
 * const pullRequest = await github.openPullRequest(repository, { ...text, closes: issue })
 * ```
 */
export async function describe(
	agent: Agent,
	repository: Repository,
	options: DescribeOptions = {},
	context?: ToolContext,
): Promise<PullRequestText> {
	return describeFrom(agent, repository, await brief(repository)({}, context), options)
}

/**
 * Describes the pull request again once its branch has commits the description doesn't cover yet,
 * such as after a round of review that changed the code: the agent writes the description afresh,
 * for the branch as it is now. When the description already covers the checkout's `HEAD`, or the
 * pull request is closed, nothing runs, so calling it after every round costs a look.
 *
 * ```ts
 * comments: async (comments) => {
 * 	await developer.loop`Handle these review comments on ${pullRequest}: ${comments}. ...`
 * 	await github.redescribe(writer, pullRequest, repository, { issue })
 * }
 * ```
 */
export async function redescribe(
	agent: Agent,
	pullRequest: PullRequestRef,
	repository: Repository,
	options: DescribeOptions = {},
	context?: ToolContext,
): Promise<PullRequest> {
	const where = { repository: pullRequest.repository, number: pullRequest.number }
	const current = await stubs.getPullRequest(where, context)
	const read = await brief(repository)({}, context)
	if (current.state === 'closed' || current.described === read.head) return pullRequestOf(current)
	const text = await describeFrom(agent, repository, read, options)
	const body = withClosingReference(text.description, options.issue, repository.name)
	return pullRequestOf(await stubs.updatePullRequest({ ...where, title: text.title, body, described: read.head }, context))
}

function describeFrom(agent: Agent, repository: Repository, read: PullRequestBrief, options: DescribeOptions): Promise<PullRequestText> {
	return agent.loop`
		Write the title and the description of the pull request that merges branch \`${repository.branch}\` of
		${repository.name} into \`${read.base}\`. The checkout is ${repository}. ${issuePart(options.issue)}

		The commits on the branch, oldest first:
		${read.commits}

		What the branch changes against \`${read.base}\`:
		${read.stat}
		The whole diff is in ${read.diff}.

		Describe the branch as it is now against \`${read.base}\`: what is different, and why it was done this
		way. The reader reviews the result as it is, so nobody cares what happened on the way there: no earlier
		attempts, no review rounds, nothing like "previously we did" or "this update changes". Don't list the
		commits one by one, and say only what the commits, the diff and the issue back up.

		${templatePart(read)}

		${lintPart(read)}

		The reference that closes the issue and the signature are added for you: leave them out.
		When both are written, ${succeed(PullRequestText)}.
		${options.limit ?? defaultLimit}
	`
}

function issuePart(issue: Issue | undefined): Prompt | string {
	return issue === undefined ? '' : prompt`It resolves the issue in ${issue}: read it for why the change is needed.`
}

function templatePart(read: PullRequestBrief): Prompt {
	if (read.templates.length === 0)
		return prompt`
			The repository has no pull request template. Write the description in Markdown with these sections:
			\`## What changes\`, \`## Why\` and \`## Testing\` (how it was tested, or that it wasn't).
		`
	return prompt`
		The repository has a pull request template: fill it in. Keep its headings, their order and its checkboxes,
		tick only what is true, and replace its instructions and placeholders with the answers. When it has
		several, use the one that fits the change.

		${filesInPrompt(read.templates)}
	`
}

function lintPart(read: PullRequestBrief): Prompt {
	if (read.lintSettings.length === 0)
		return prompt`Keep the title under 72 characters, in the style the branch's commit subjects and the repository use.`
	return prompt`
		The repository lints commit messages or pull request titles with the settings below. The title has to
		pass them as a commit header, and the description as a commit body.

		${filesInPrompt(read.lintSettings)}
	`
}
