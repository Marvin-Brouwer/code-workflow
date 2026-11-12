import { limit, prompt, succeed, type Agent, type Limit, type Prompt } from '@mesh-flow/core'
import type { Issue } from '../issue/issue.mts'
import { sameRepositoryName } from '../repository-name.mts'
import type { Repository } from '../repository/repository.mts'
import type { PullRequestRef } from '../tools/pull-request-tools.mts'
import { branchHead } from './branch-head.mts'
import { readBrief, type PullRequestBrief } from './brief.mts'
import { fenced } from './fenced.mts'
import { openPullRequestOf, pullRequest, type PullRequest } from './pull-request.mts'
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
	 * cover that commit. It has to be the pull request of the checkout's branch onto the default branch.
	 */
	readonly pullRequest?: PullRequestRef
	/** The limit of the loop. Default: 10 minutes. */
	readonly limit?: Limit
}

/** How long the loop may take when the caller sets no limit. */
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
 * branch without commits of its own is refused. When the branch has an open pull request all the
 * same, as when a run starts over after a round of review, the agent starts from its text, and no
 * loop runs when that text already covers `HEAD`.
 *
 * With `pullRequest`, it describes that pull request again, for after a round of review: the agent
 * rewrites the current text for the branch as it was last pushed. When the text already covers
 * that commit, or the pull request is closed, no loop runs and the current text comes back,
 * so calling it after every round costs a read of the pull request and of the branch's commit. Writing the text is up to the caller: the result,
 * which closes `issue`, goes to `openPullRequest` or `updatePullRequest` as it is; it names the text
 * it was written from, so a person who edited the pull request meanwhile is asked before their edit
 * is overwritten. A pull request
 * of another branch, or onto another branch than the default one, is refused.
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
	// Without one named, the branch's open pull request all the same: a run that starts over after a
	// round of review starts from the text that was reviewed, not from nothing.
	const current =
		options.pullRequest === undefined ? await openPullRequestOf(repository) : await branchPullRequest(options.pullRequest, repository)
	if (current?.state === 'closed') return currentContent(current, options.issue)
	// For a pull request named, what it shows: the branch as it was pushed. Else what `openPullRequest` will push.
	const head = await branchHead(repository)({ pushed: options.pullRequest !== undefined })
	if (current?.describedSha === head) return currentContent(current, options.issue)
	const brief = await readBrief(repository)({ head })
	const text = await writeText(agent, repository, brief, options, current)
	return { ...text, describedSha: head, ...closesIssue(options.issue), ...basedOnText(current) }
}

/** The `basedOn` field of the content: the text of the pull request it was written from, when there is one. */
function basedOnText(current: PullRequest | undefined): { basedOn?: PullRequestText } {
	return current === undefined ? {} : { basedOn: { title: current.title, description: current.description } }
}

/** The pull request `ref` names, which has to be the one of the checkout's branch onto the default branch. */
async function branchPullRequest(ref: PullRequestRef, repository: Repository): Promise<PullRequest> {
	const current = await pullRequest(ref)
	if (!sameRepositoryName(current.repository, repository.name) || current.head.branch !== repository.branch)
		throw new Error(`${current.url} is the pull request of ${current.head.branch}, not of ${repository.name} ${repository.branch}.`)
	if (current.base !== repository.defaultBranch)
		throw new Error(
			`${current.url} merges into ${current.base}, not into ${repository.defaultBranch}, which the branch is described against.`,
		)
	return current
}

/** What the pull request says now, as `describe` resolves to it when no loop runs. */
function currentContent(current: PullRequest, closes: Issue | undefined): PullRequestContent {
	const { title, description, describedSha } = current
	return { title, description, ...(describedSha === undefined ? {} : { describedSha }), ...closesIssue(closes), ...basedOnText(current) }
}

/** The `closes` field of the content, for when it closes an issue. */
function closesIssue(issue: Issue | undefined): { closes?: Issue } {
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
		The whole diff is in ${brief.diffPath}.

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
