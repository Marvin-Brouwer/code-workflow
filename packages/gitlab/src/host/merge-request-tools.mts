import { sameText } from '@mesh-flow/code-repository'
import {
	descriptionOf,
	footerCloses,
	later,
	oneAtATime,
	replyToItem,
	sameBody,
	showItemsBeingRead,
	signedDescription,
} from '@mesh-flow/code-repository/host'
import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { z } from 'zod'
import {
	findMergeRequest,
	getMergeRequest,
	openMergeRequest,
	replyToReviewItem,
	reviewActivity,
	showBeingRead,
	updateMergeRequest,
	type MergeRequestData,
} from '../tools/merge-request-tools.mts'
import { GitlabRequestError, projectSegment, refusedToken, type ApiClient, type GitlabClient } from './api.mts'
import { discussionsOf, mergeRequestNotes, mergeRequestPath, noteIdOf, readingNote, reviewItemsOf } from './merge-request-notes.mts'

/** A merge request as GitLab's API has it, in the fields the tools pass on. */
const ApiMergeRequest = z.object({
	iid: z.int(),
	title: z.string(),
	description: z.string().nullable().optional(),
	web_url: z.url(),
	state: z.string(),
	source_branch: z.string(),
	target_branch: z.string(),
	sha: z.string().nullable().optional(),
	merge_commit_sha: z.string().nullable().optional(),
	squash_commit_sha: z.string().nullable().optional(),
})
type ApiMergeRequest = z.infer<typeof ApiMergeRequest>

/** A commit id GitLab hasn't filled in, as on a merge request it is still preparing. */
const noCommit = '0'.repeat(40)

function mergeRequestData(repository: string, data: ApiMergeRequest): MergeRequestData {
	const merged = data.state === 'merged'
	const head = data.sha ?? noCommit
	// A fast-forward merge leaves no commit of its own: the head is what the target branch is at.
	const mergedSha = data.merge_commit_sha ?? data.squash_commit_sha ?? (merged ? head : undefined)
	return {
		repository,
		number: data.iid,
		title: data.title,
		url: data.web_url,
		// Locked is GitLab's state while a merge goes on: still open until it's merged.
		state: merged || data.state === 'closed' ? 'closed' : 'open',
		merged,
		head: { branch: data.source_branch, sha: head },
		base: data.target_branch,
		...descriptionOf(data.description),
		...(mergedSha === undefined ? {} : { mergedSha }),
	}
}

/**
 * The open merge request of branch `head` onto `base`, when there is one. GitLab keeps one open
 * merge request per source branch, whatever its target: one onto another branch, such as after a
 * reviewer changed its target, can't be opened again or reused, so it fails the call, naming it.
 */
async function openOnBranch(client: GitlabClient, project: string, head: string, base: string): Promise<ApiMergeRequest | undefined> {
	const { items } = await client.firstPage(`${projectSegment(project)}/merge_requests`, ApiMergeRequest, 1, {
		state: 'opened',
		source_branch: head,
	})
	const open = items[0]
	if (open !== undefined && open.target_branch !== base)
		throw new Error(`${head} already has an open merge request onto ${open.target_branch}, not ${base}: ${open.web_url}`)
	return open
}

/** GitLab's answer to a merge request opened for a branch that has one open already, as when two runs open it at once. */
const conflict = 409

/** What opening a merge request takes. */
interface NewMergeRequest {
	readonly source_branch: string
	readonly target_branch: string
	readonly title: string
	readonly description: string
}

/** Opens a merge request, or takes the one another call opened for the branch meanwhile. */
async function opened(client: GitlabClient, project: string, body: NewMergeRequest): Promise<ApiMergeRequest> {
	try {
		return await client.request('POST', `${projectSegment(project)}/merge_requests`, ApiMergeRequest, { body })
	} catch (error) {
		if (!(error instanceof GitlabRequestError && error.status === conflict)) throw error
		const meanwhile = await openOnBranch(client, project, body.source_branch, body.target_branch)
		if (meanwhile === undefined) throw error
		return meanwhile
	}
}

/** The host halves of the merge request tools. */
export function mergeRequestHostTools(api: ApiClient): HostTool[] {
	const perItem = oneAtATime()
	return [
		hostTool(openMergeRequest, async ({ repository, head, base, title, body, describedSha, closes }, context) => {
			const client = await api(context)
			const signedBody = signedDescription(body, context.runId, { describedSha, closes })
			const existing = await openOnBranch(client, repository, head, base)
			if (existing === undefined) {
				const created = await opened(client, repository, { source_branch: head, target_branch: base, title, description: signedBody })
				return mergeRequestData(repository, created)
			}
			// Already described for this commit, as on a rerun: the text stays as it was reviewed.
			const closesAlready = closes === undefined || footerCloses(existing.description, closes)
			if (descriptionOf(existing.description).describedSha === describedSha && closesAlready) return mergeRequestData(repository, existing)
			const updated = await client.request('PUT', mergeRequestPath(repository, existing.iid), ApiMergeRequest, {
				body: { title, description: signedBody },
			})
			return mergeRequestData(repository, updated)
		}),

		hostTool(updateMergeRequest, async ({ repository, number, title, body, describedSha, closes, seen }, context) => {
			const client = await api(context)
			const where = mergeRequestPath(repository, number)
			const current = await client.request('GET', where, ApiMergeRequest)
			const data = mergeRequestData(repository, current)
			// A closed merge request keeps the text it was reviewed with.
			if (data.state === 'closed') return { ...data, skipped: 'closed' as const }
			// Edited since the caller looked: the caller asks the person again rather than write over it.
			const now = { title: current.title, description: data.description }
			if (seen !== undefined && !sameText(now, seen) && !sameText(now, { title, description: body }))
				return { ...data, skipped: 'edited' as const }
			const signedBody = signedDescription(body, context.runId, { describedSha, closes })
			if (current.title === title && sameBody(current.description, signedBody)) return { ...data, skipped: 'unchanged' as const }
			const updated = await client.request('PUT', where, ApiMergeRequest, { body: { title, description: signedBody } })
			return mergeRequestData(repository, updated)
		}),

		hostTool(findMergeRequest, async ({ repository, head, base }, context) => {
			const found = await openOnBranch(await api(context), repository, head, base)
			return found === undefined ? null : mergeRequestData(repository, found)
		}),

		hostTool(getMergeRequest, async ({ repository, number }, context) => {
			const client = await api(context)
			return mergeRequestData(repository, await client.request('GET', mergeRequestPath(repository, number), ApiMergeRequest))
		}),

		hostTool(reviewActivity, async ({ repository, number, since }, context) => {
			const client = await api(context)
			const after = since === undefined ? undefined : new Date(since).getTime()
			// At or after: an item at the moment of the last one seen comes again, and the caller keeps the ids it handled.
			const items = reviewItemsOf(await discussionsOf(client, repository, number), client.url, repository, number)
				.filter((item) => after === undefined || new Date(item.at).getTime() >= after)
				.toSorted((one, other) => one.at.localeCompare(other.at))
			// The clock is GitLab's, never the host's: the two can disagree, and a note made while the list was read must come next time.
			const until = later(since, items.at(-1)?.at)
			return { items, ...(until === undefined ? {} : { until }) }
		}),

		hostTool(replyToReviewItem, ({ repository, number, item, body, stage }, context) =>
			// One answer at a time per item: two at once would both find the reading reply, and one would overwrite the other.
			perItem(`${repository}!${String(number)}#${item}`, context.abortSignal, async () => {
				const comments = mergeRequestNotes(await api(context), repository, number)
				return replyToItem(comments, {
					item,
					kind: 'note',
					commentId: noteIdOf(item),
					body,
					stage: stage ?? 'answer',
					runId: context.runId,
				})
			}),
		),

		hostTool(showBeingRead, async ({ repository, number, items }, context) => {
			const comments = mergeRequestNotes(await api(context), repository, number)
			const toShow = items.map((item) => {
				const commentId = noteIdOf(item)
				return { item, kind: 'note' as const, commentId, note: readingNote, thread: () => comments.threadOf('note', commentId) }
			})
			return showItemsBeingRead(comments, toShow, { runId: context.runId, abortSignal: context.abortSignal, failsCall: refusedToken })
		}),
	]
}
