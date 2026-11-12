import { sameText } from '@mesh-flow/forge'
import {
	answeredKey,
	descriptionOf,
	footerCloses,
	oneAtATime,
	reactionKey,
	repliedKey,
	replyKey,
	replyToItem,
	sameBody,
	seenKey,
	signed,
	signedDescription,
} from '@mesh-flow/forge/host'
import { commentMarker } from '@mesh-flow/forge'
import { hostTool, isTransient, type HostTool } from '@mesh-flow/gateway'
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
import { refusedToken, type ApiClient, type GitlabClient } from './api.mts'
import { discussionsOf, mergeRequestNotes, mergeRequestPath, noteIdOf, readingNote, reviewItemsOf } from './merge-request-notes.mts'
import { projectSegment } from './api.mts'

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

/** The latest of two moments, either of which may be missing. */
function later(seen: string | undefined, latest: string | undefined): string | undefined {
	if (seen === undefined) return latest
	if (latest === undefined) return seen
	return new Date(seen).getTime() >= new Date(latest).getTime() ? seen : latest
}

/** The open merge request of branch `head` onto `base`, when there is one. */
async function openOnBranch(client: GitlabClient, project: string, head: string, base: string): Promise<ApiMergeRequest | undefined> {
	const { items } = await client.firstPage(`${projectSegment(project)}/merge_requests`, ApiMergeRequest, 1, {
		state: 'opened',
		source_branch: head,
		target_branch: base,
	})
	return items[0]
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
				const created = await client.request('POST', `${projectSegment(repository)}/merge_requests`, ApiMergeRequest, {
					body: { source_branch: head, target_branch: base, title, description: signedBody },
				})
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
			const replies = await comments.ownReplies(['note'])
			const hasReply = (key: string) => replies.some((reply) => reply.body.includes(commentMarker(key)))
			const shown: string[] = []
			const answered: string[] = []
			// One at a time: GitLab limits bursts of writes, and a round of review can bring many items.
			for (const item of items) {
				const noteId = noteIdOf(item)
				// An answer replaced the reading reply, or is a reply of its own when there was none.
				if (hasReply(answeredKey(item)) || hasReply(repliedKey(item))) {
					answered.push(item)
					continue
				}
				try {
					const reaction = await comments.react('note', noteId)
					if (!hasReply(seenKey(item))) {
						const thread = await comments.threadOf('note', noteId)
						const reactionKeys = reaction === undefined ? [] : [reactionKey(reaction)]
						await comments.post('note', thread, signed(readingNote, context.runId, [replyKey, seenKey(item), ...reactionKeys]))
					}
					shown.push(item)
				} catch (error) {
					// A deleted note just isn't shown. What may pass is tried again, and a stopped call or a bad
					// token is no reason to say the items were shown.
					if (isTransient(error) || context.abortSignal.aborted || refusedToken(error)) throw error
				}
			}
			return { shown, answered }
		}),
	]
}
