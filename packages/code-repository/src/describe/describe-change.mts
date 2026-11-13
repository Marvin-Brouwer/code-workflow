import { limit, prompt, succeed, type Agent, type Limit, type Prompt } from '@mesh-flow/core'
import type { z } from 'zod'
import type { Checkout } from '../checkout/checkout.mts'
import { readBrief, type ChangeBrief } from './brief.mts'
import type { ChangeRequest, CodeHostTerms } from './change-request.mts'
import { textInPrompt, type BasedOn, type ChangeContent, type ChangeText } from './change-text.mts'
import { fenced } from './fenced.mts'
import { filesInPrompt, type ChangeRequestLayout } from './repository-files.mts'

/** How a code host's connector reads what `describeChange` needs: its pull or merge requests, and where their templates are. */
export interface DescribeCodeHost<Repository extends Checkout, Request extends ChangeRequest, Ref> {
	readonly terms: CodeHostTerms
	readonly layout: ChangeRequestLayout
	/** What the agent finishes with, within the code host's limits: see `changeTextSchema`. */
	readonly text: z.ZodType<ChangeText>
	/** Whether two names are of the same repository, as the code host compares them. */
	readonly sameRepository: (one: string, other: string) => boolean
	/** The open pull or merge request of the checkout's branch onto the default branch, when it has one. */
	readonly findOpen: (repository: Repository) => Promise<Request | undefined>
	/** A pull or merge request as it is now. */
	readonly read: (ref: Ref) => Promise<Request>
	/** The commit the branch is at: the checkout's `HEAD`, or with `pushed` the branch as it was last pushed. */
	readonly head: (repository: Repository, pushed: boolean) => Promise<string>
}

/** What `describeChange` takes besides the agent, the checkout and the code host. */
export interface DescribeChangeOptions<Ref, Closes> {
	/** What the branch resolves, such as an issue, which the agent reads for the why, and which the result closes. */
	readonly closes?: Closes
	/** The pull or merge request the branch already has, to describe again. */
	readonly request?: Ref
	/** The limit of the loop. Default: 10 minutes. */
	readonly limit?: Limit
}

/** How long the loop may take when the caller sets no limit. */
const defaultLimit = limit({ minutes: 10 })

/** Git's customary width of a commit subject, for a title when the repository sets none. */
const customaryTitleCharacters = 72

/**
 * Has `agent` write the title and description of the pull or merge request for a checkout's branch,
 * in one loop, from the branch's commits and diff, the repository's templates and the settings
 * that lint its commit messages or titles. `closes` renders in the prompt where the agent
 * reads it, so it has to be a value that renders, such as an issue.
 */
export async function describeChange<Repository extends Checkout, Request extends ChangeRequest, Ref, Closes>(
	agent: Agent,
	repository: Repository,
	codeHost: DescribeCodeHost<Repository, Request, Ref>,
	options: DescribeChangeOptions<Ref, Closes> = {},
): Promise<ChangeContent<Closes>> {
	// Without one named, the branch's open request all the same: a run that starts over after a
	// round of review starts from the text that was reviewed, not from nothing.
	const current =
		options.request === undefined ? await codeHost.findOpen(repository) : await branchRequest(options.request, repository, codeHost)
	if (current?.state === 'closed') return currentContent(current, options.closes)
	// For a request named, what it shows: the branch as it was pushed. Else what opening one will push.
	const head = await codeHost.head(repository, options.request !== undefined)
	if (current?.describedSha === head) return currentContent(current, options.closes)
	const brief = await readBrief(repository, codeHost.terms, codeHost.layout)({ head })
	const text = await writeText(agent, repository, codeHost.terms, codeHost.text, brief, options, current)
	return { ...text, describedSha: head, ...closesField(options.closes), ...basedOnField(current) }
}

/** The `basedOn` field of the content: the request it was written from, by number, and what it said then, when there is one. */
function basedOnField(current: ChangeRequest | undefined): { basedOn?: BasedOn } {
	return current === undefined
		? {}
		: { basedOn: { repository: current.repository, number: current.number, title: current.title, description: current.description } }
}

/** The request `ref` names, which has to be the one of the checkout's branch onto the default branch. */
async function branchRequest<Repository extends Checkout, Request extends ChangeRequest, Ref>(
	ref: Ref,
	repository: Repository,
	codeHost: DescribeCodeHost<Repository, Request, Ref>,
): Promise<Request> {
	const current = await codeHost.read(ref)
	if (!codeHost.sameRepository(current.repository, repository.name) || current.head.branch !== repository.branch)
		throw new Error(
			`${current.url} is the ${codeHost.terms.request} of ${current.head.branch}, not of ${repository.name} ${repository.branch}.`,
		)
	if (current.base !== repository.defaultBranch)
		throw new Error(
			`${current.url} merges into ${current.base}, not into ${repository.defaultBranch}, which the branch is described against.`,
		)
	return current
}

/** What the request says now, as `describeChange` resolves to it when no loop runs. */
function currentContent<Closes>(current: ChangeRequest, closes: Closes | undefined): ChangeContent<Closes> {
	const { title, description, describedSha } = current
	return { title, description, ...(describedSha === undefined ? {} : { describedSha }), ...closesField(closes), ...basedOnField(current) }
}

/** The `closes` field of the content, for when it closes something. */
function closesField<Closes>(closes: Closes | undefined): { closes?: Closes } {
	return closes === undefined ? {} : { closes }
}

/** The loop itself: the agent writes the text from the brief, and from the current text when there is one. */
function writeText<Closes>(
	agent: Agent,
	repository: Checkout,
	terms: CodeHostTerms,
	text: z.ZodType<ChangeText>,
	brief: ChangeBrief,
	options: DescribeChangeOptions<unknown, Closes>,
	current: ChangeText | undefined,
): Promise<ChangeText> {
	const { request } = terms
	return agent.loop`
		Write the title and the description of the ${request} that merges branch \`${repository.branch}\` of
		${repository.name} into \`${brief.base}\`. The checkout is ${repository}. ${closesPart(options.closes)}

		It describes the branch at commit ${brief.headSha}. The commits on the branch, oldest first:
		${fenced(brief.commitLog)}

		What the branch changes against \`${brief.base}\`:
		${fenced(brief.diffStat)}
		The whole diff is in ${brief.diffPath}.

		Describe the branch as it is now against \`${brief.base}\`: what is different, and why it was done this
		way. The reader reviews the result as it is, so nobody cares what happened on the way there: no earlier
		attempts, no review rounds, nothing like "previously we did" or "this update changes". Don't list the
		commits one by one, and say only what the commits, the diff and the issue back up.

		${currentPart(current, request)}

		${templatePart(brief, request)}

		${lintPart(brief, request)}

		The reference that closes the issue and the signature are added for you: leave them out.
		When both are written, ${succeed(text)}.
		${options.limit ?? defaultLimit}
	`
}

/** The text the request has now, to start from: written for an earlier state of the branch. */
function currentPart(current: ChangeText | undefined, request: string): Prompt | string {
	if (current === undefined) return ''
	return prompt`
		The ${request} has a title and a description already, written for an earlier state of the branch.
		Start from them: keep what still holds and its wording, change what no longer does, and add what is
		new, so the result reads as if it was written for the branch as it is now.

		${textInPrompt(current)}
	`
}

/** Where the issue is, for the why. */
function closesPart(closes: unknown): Prompt | string {
	return closes === undefined ? '' : prompt`It resolves the issue in ${closes}: read it for why the change is needed.`
}

/** The template to fill in, or the default shape without one. */
function templatePart(brief: ChangeBrief, request: string): Prompt {
	if (brief.templates.length === 0)
		return prompt`
			The repository has no ${request} template. Write the description in Markdown with these sections:
			\`## What changes\`, \`## Why\` and \`## Testing\` (how it was tested, or that it wasn't).
		`
	return prompt`
		The repository has a ${request} template: fill it in. Keep its headings, their order and its checkboxes,
		tick only what is true, and replace its instructions and placeholders with the answers. When it has
		several, use the one that fits the change.

		${filesInPrompt(brief.templates)}
	`
}

/** The lint settings to keep to, or a short title without them. */
function lintPart(brief: ChangeBrief, request: string): Prompt {
	if (brief.lintSettings.length === 0)
		return prompt`Keep the title under ${customaryTitleCharacters} characters, in the style the branch's commit subjects and the repository use.`
	return prompt`
		The repository lints commit messages or ${request} titles with the settings below. The title has to
		pass them as a commit header, and the description as a commit body.

		${filesInPrompt(brief.lintSettings)}
	`
}
