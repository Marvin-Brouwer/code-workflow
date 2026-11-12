import { sameRepositoryName } from '../repository-name.mts'
import { limit, prompt, succeed, type Agent, type Limit, type Prompt, type ToolContext } from '@mesh-flow/core'
import type { Issue } from '../issue/issue.mts'
import type { Repository } from '../repository/repository.mts'
import type { PullRequestRef } from '../tools/pull-request-tools.mts'
import { readBrief, type PullRequestBrief } from './brief.mts'
import { fenced } from './fenced.mts'
import { pullRequest, type PullRequest } from './pull-request.mts'
import { PullRequestText, textInPrompt, type PullRequestContent } from './pull-request-text.mts'
import { filesInPrompt } from './repository-files.mts'

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
	 * cover that commit. It has to be the pull request of the checkout's branch.
	 */
	readonly pullRequest?: PullRequestRef
	/** The limit of the loop. Default: 10 minutes. */
	readonly limit?: Limit
}

const defaultLimit = limit({ minutes: 10 })

/** Git's customary width of a commit subject, for a title when the repository sets none. */
const customaryTitleCharacters = 72

/**
 * Has `agent` write the title and description of the pull request for a checkout's branch, in one
 * loop. Code reads what the agent needs first: the branch's commits and diff against the default
 * branch, the repository's pull request template, and its settings that lint commit messages or
 * pull request titles; the agent fills the template in, or a default shape when there is none, and
 * keeps to those settings. The description says what the branch changes and why, as it is now:
 * never what happened on the way there. The package ships no agent: the workflow passes its own.
 * Without `pullRequest`, what is described is what is committed, at the checkout's `HEAD`; a
 * branch without commits of its own is refused.
 *
 * With `pullRequest`, it describes that pull request again, for after a round of review: the agent
 * rewrites the current text for the branch as it was last pushed. When the text already covers
 * that commit, or the pull request is closed, no loop runs and the current text comes back,
 * so calling it after every round costs a look. Writing the text is up to the caller: the result,
 * which closes `issue`, goes to `openPullRequest` or `updatePullRequest` as it is.
 *
 * ```ts
 * const pullRequest = await github.openPullRequest(repository, await github.describe(writer, repository, { issue }))
 * // After a round of review:
 * await github.updatePullRequest(pullRequest, await github.describe(writer, repository, { issue, pullRequest }))
 * ```
 */
export async function describe(
	agent: Agent,
	repository: Repository,
	options: DescribeOptions = {},
	context?: ToolContext,
): Promise<PullRequestContent> {
	const current = options.pullRequest === undefined ? undefined : await pullRequestOf(options.pullRequest, repository, context)
	if (current?.state === 'closed') return currentContent(current, options.issue)
	// For a pull request that is open, what it shows: the branch as it was pushed.
	const brief = await readBrief(repository)({ pushed: current !== undefined }, context)
	if (current !== undefined && current.describedSha === brief.headSha) return currentContent(current, options.issue)
	const text = await writeText(agent, repository, brief, options, current)
	return { ...text, describedSha: brief.headSha, ...closesField(options.issue) }
}

/** The pull request `ref` names, which has to be the one of the checkout's branch. */
async function pullRequestOf(ref: PullRequestRef, repository: Repository, context: ToolContext | undefined): Promise<PullRequest> {
	const current = await pullRequest(ref, context)
	if (!sameRepositoryName(current.repository, repository.name) || current.head.branch !== repository.branch)
		throw new Error(`${current.url} is the pull request of ${current.head.branch}, not of ${repository.name} ${repository.branch}.`)
	return current
}

/** What the pull request says now, as `describe` resolves to it when no loop runs. */
function currentContent(current: PullRequest, closes: Issue | undefined): PullRequestContent {
	const { title, description, describedSha } = current
	return { title, description, ...(describedSha === undefined ? {} : { describedSha }), ...closesField(closes) }
}

/** The `closes` field of the content, for when it closes an issue. */
function closesField(issue: Issue | undefined): { closes?: Issue } {
	return issue === undefined ? {} : { closes: issue }
}

/** The loop itself: the agent writes the text from the brief, and from the current text when there is one. */
function writeText(
	agent: Agent,
	repository: Repository,
	brief: PullRequestBrief,
	options: DescribeOptions,
	current: PullRequestText | undefined,
): Promise<PullRequestText> {
	return agent.loop`
		Write the title and the description of the pull request that merges branch \`${repository.branch}\` of
		${repository.name} into \`${brief.base}\`. The checkout is ${repository}. ${issuePart(options.issue)}

		It describes the branch at commit ${brief.headSha}. The commits on the branch, oldest first:
		${fenced(brief.commitLog)}

		What the branch changes against \`${brief.base}\`:
		${fenced(brief.diffStat)}
		The whole diff is in ${brief.diff}.

		Describe the branch as it is now against \`${brief.base}\`: what is different, and why it was done this
		way. The reader reviews the result as it is, so nobody cares what happened on the way there: no earlier
		attempts, no review rounds, nothing like "previously we did" or "this update changes". Don't list the
		commits one by one, and say only what the commits, the diff and the issue back up.

		${currentPart(current)}

		${templatePart(brief)}

		${lintPart(brief)}

		The reference that closes the issue and the signature are added for you: leave them out.
		When both are written, ${succeed(PullRequestText)}.
		${options.limit ?? defaultLimit}
	`
}

/** The text the pull request has now, to start from: written for an earlier state of the branch. */
function currentPart(current: PullRequestText | undefined): Prompt | string {
	if (current === undefined) return ''
	return prompt`
		The pull request has a title and a description already, written for an earlier state of the branch.
		Start from them: keep what still holds and its wording, change what no longer does, and add what is
		new, so the result reads as if it was written for the branch as it is now.

		${textInPrompt(current)}
	`
}

/** Where the issue is, for the why. */
function issuePart(issue: Issue | undefined): Prompt | string {
	return issue === undefined ? '' : prompt`It resolves the issue in ${issue}: read it for why the change is needed.`
}

/** The template to fill in, or the default shape without one. */
function templatePart(brief: PullRequestBrief): Prompt {
	if (brief.templates.length === 0)
		return prompt`
			The repository has no pull request template. Write the description in Markdown with these sections:
			\`## What changes\`, \`## Why\` and \`## Testing\` (how it was tested, or that it wasn't).
		`
	return prompt`
		The repository has a pull request template: fill it in. Keep its headings, their order and its checkboxes,
		tick only what is true, and replace its instructions and placeholders with the answers. When it has
		several, use the one that fits the change.

		${filesInPrompt(brief.templates)}
	`
}

/** The lint settings to keep to, or a short title without them. */
function lintPart(brief: PullRequestBrief): Prompt {
	if (brief.lintSettings.length === 0)
		return prompt`Keep the title under ${customaryTitleCharacters} characters, in the style the branch's commit subjects and the repository use.`
	return prompt`
		The repository lints commit messages or pull request titles with the settings below. The title has to
		pass them as a commit header, and the description as a commit body.

		${filesInPrompt(brief.lintSettings)}
	`
}
