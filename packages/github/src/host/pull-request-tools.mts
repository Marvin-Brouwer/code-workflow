import { hostTool, isTransient, type HostTool } from '@mesh-flow/gateway'
import { z } from 'zod'
import { splitRepositoryName } from '../repository-name.mts'
import { commentMarker, isMarked, markerValue } from '../tools/issue-tools.mts'
import {
	checksOnRef,
	type ChecksStatus,
	getPullRequest,
	showBeingRead,
	openPullRequest,
	replyToReviewItem,
	reviewActivity,
	ReviewItemKind,
	type CheckFailure,
	type PullRequestData,
	type ReviewItem,
} from '../tools/pull-request-tools.mts'
import { pageSize, type ApiClient } from './api.mts'
import { oneAtATime } from './one-at-a-time.mts'
import { answeredKey, pullRequestComments, reactionKey, readingNote, replyKey, seenKey } from './review-replies.mts'
import { signed } from './signature.mts'

/** What the API returns for a pull request, in the fields the tools pass on. */
interface ApiPullRequest {
	readonly number: number
	readonly title: string
	readonly html_url: string
	readonly state: string
	readonly merged_at?: string | null
	readonly merged?: boolean
	readonly head: { readonly ref: string; readonly sha: string }
	readonly base: { readonly ref: string }
}

function pullRequestData(repository: string, data: ApiPullRequest): PullRequestData {
	return {
		repository,
		number: data.number,
		title: data.title,
		url: data.html_url,
		state: data.state === 'closed' ? 'closed' : 'open',
		merged: data.merged ?? (data.merged_at !== null && data.merged_at !== undefined),
		head: { branch: data.head.ref, sha: data.head.sha },
		base: data.base.ref,
	}
}

/** A review's verdict as GitHub states it, in the words {@link ReviewItem} uses. */
const verdicts: Record<string, ReviewItem['verdict']> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'changes_requested',
	COMMENTED: 'commented',
	DISMISSED: 'dismissed',
}

/** Check conclusions and status states that count as failed. */
const failedConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'])

const secondMs = 1_000

/** The latest of two moments, either of which may be missing. */
function later(seen: string | undefined, latest: string | undefined): string | undefined {
	if (seen === undefined) return latest
	if (latest === undefined) return seen
	return seen.localeCompare(latest) >= 0 ? seen : latest
}

/** The host halves of the pull request tools. */
export function pullRequestHostTools(api: ApiClient): HostTool[] {
	const perItem = oneAtATime()
	return [
		hostTool(openPullRequest, async ({ repository, head, base, title, body }, context) => {
			const client = await api(context)
			const where = splitRepositoryName(repository)
			const { data: open } = await client.rest.pulls.list({ ...where, state: 'open', head: `${where.owner}:${head}`, base, per_page: 1 })
			const [existing] = open
			if (existing !== undefined) return pullRequestData(repository, existing)
			const { data } = await client.rest.pulls.create({ ...where, head, base, title, body })
			return pullRequestData(repository, data)
		}),

		hostTool(getPullRequest, async ({ repository, number }, context) => {
			const client = await api(context)
			const { data } = await client.rest.pulls.get({ ...splitRepositoryName(repository), pull_number: number })
			return pullRequestData(repository, data)
		}),

		hostTool(reviewActivity, async ({ repository, number, since }, context) => {
			const client = await api(context)
			const where = splitRepositoryName(repository)
			const after = since === undefined ? undefined : new Date(since).getTime()
			// GitHub may take `since` as strictly after, at second precision: ask from a second earlier and filter here.
			const listSince = after === undefined ? {} : { since: new Date(after - secondMs).toISOString() }
			// At or after: GitHub keeps seconds, so a comment in the same second as the last one seen would be lost otherwise.
			const isNew = (at: string | null | undefined): at is string =>
				at !== null && at !== undefined && (after === undefined || new Date(at).getTime() >= after)
			const [lineComments, reviews, comments] = await Promise.all([
				client.paginate(client.rest.pulls.listReviewComments, {
					...where,
					pull_number: number,
					per_page: pageSize,
					...listSince,
				}),
				client.paginate(client.rest.pulls.listReviews, { ...where, pull_number: number, per_page: pageSize }),
				client.paginate(client.rest.issues.listComments, {
					...where,
					issue_number: number,
					per_page: pageSize,
					...listSince,
				}),
			])
			const items: ReviewItem[] = [
				...lineComments
					.filter((comment) => isNew(comment.created_at) && !isMarked(comment.body))
					.map((comment) => ({
						id: itemId('review-comment', comment.id),
						kind: 'review-comment' as const,
						author: comment.user.login,
						body: comment.body,
						url: comment.html_url,
						at: comment.created_at,
						path: comment.path,
						...(comment.line === undefined ? {} : { line: comment.line }),
						...(comment.in_reply_to_id === undefined ? {} : { inReplyTo: itemId('review-comment', comment.in_reply_to_id) }),
					})),
				...reviews
					.filter((review) => isNew(review.submitted_at) && !isMarked(review.body) && (review.body !== '' || review.state !== 'COMMENTED'))
					.map((review) => ({
						id: itemId('review', review.id),
						kind: 'review' as const,
						author: review.user?.login ?? '',
						body: review.body,
						url: review.html_url,
						at: review.submitted_at ?? new Date().toISOString(),
						...(verdicts[review.state] === undefined ? {} : { verdict: verdicts[review.state] }),
					})),
				...comments
					.filter((comment) => isNew(comment.created_at) && !isMarked(comment.body))
					.map((comment) => ({
						id: itemId('comment', comment.id),
						kind: 'comment' as const,
						author: comment.user?.login ?? '',
						body: comment.body ?? '',
						url: comment.html_url,
						at: comment.created_at,
					})),
			].toSorted((a, b) => a.at.localeCompare(b.at))
			// The clock is GitHub's, never the host's: the two can disagree, and a comment made while the lists were read must come next time.
			const until = later(since, items.at(-1)?.at)
			return { items, ...(until === undefined ? {} : { until }) }
		}),

		hostTool(replyToReviewItem, ({ repository, number, item, body }, context) =>
			// One answer at a time per item: two at once would both find the reading reply, and one would overwrite the other.
			perItem(`${repository}#${String(number)}#${item}`, async () => {
				const comments = pullRequestComments(await api(context), repository, number)
				const { kind, id: commentId } = parseItemId(item)
				const reading = (await comments.ownReplies([kind])).find((reply) => reply.body.includes(commentMarker(seenKey(item))))
				if (reading === undefined) {
					const threadId = kind === 'review-comment' ? await comments.threadOf(commentId) : undefined
					return comments.post(kind, threadId, signed(body, context.runId, [replyKey]))
				}
				// Before the edit, so an answer that fails halfway finds the reading reply again when it's tried once more.
				const reaction = markerValue(reading.body, reactionKey)
				if (reaction !== undefined) await comments.unreact(kind, commentId, Number(reaction))
				return comments.edit(kind, reading.id, signed(body, context.runId, [replyKey, answeredKey(item)]))
			}),
		),

		hostTool(showBeingRead, async ({ repository, number, items }, context) => {
			const comments = pullRequestComments(await api(context), repository, number)
			const replies = await comments.ownReplies(items.map((listed) => parseItemId(listed.id).kind))
			const hasReply = (key: string) => replies.some((reply) => reply.body.includes(commentMarker(key)))
			const shown: string[] = []
			// One at a time: GitHub limits bursts of writes, and a round of review can bring many items.
			for (const { id: item, url, thread } of items) {
				const { kind, id: commentId } = parseItemId(item)
				if (hasReply(answeredKey(item))) continue
				try {
					const reaction = await comments.react(kind, commentId)
					if (!hasReply(seenKey(item))) {
						const threadId = kind === 'review-comment' ? parseItemId(thread ?? item).id : undefined
						const reactionKeys = reaction === undefined ? [] : [`${reactionKey}:${String(reaction)}`]
						await comments.post(kind, threadId, signed(readingNote(kind, url), context.runId, [replyKey, seenKey(item), ...reactionKeys]))
					}
					shown.push(item)
				} catch (error) {
					// Only a failure that may pass is worth trying again; a deleted comment or a locked conversation just isn't shown.
					if (isTransient(error)) throw error
				}
			}
			return { shown }
		}),

		hostTool(checksOnRef, async ({ repository, ref }, context) => {
			const client = await api(context)
			const where = splitRepositoryName(repository)
			const [runs, combined] = await Promise.all([
				client.paginate(client.rest.checks.listForRef, { ...where, ref, per_page: pageSize }),
				client.rest.repos.getCombinedStatusForRef({ ...where, ref }),
			])
			const progress = checksStatus(runs, combined.data.statuses)
			const failures: CheckFailure[] = [
				...runs
					.filter((run) => run.conclusion !== null && failedConclusions.has(run.conclusion))
					.map((run) => ({
						name: run.name,
						summary: run.output.summary ?? run.output.title ?? run.conclusion ?? '',
						...(run.html_url === null ? {} : { url: run.html_url }),
					})),
				...combined.data.statuses
					.filter((status) => failedConclusions.has(status.state))
					.map((status) => ({
						name: status.context,
						summary: status.description ?? status.state,
						...(status.target_url === null ? {} : { url: status.target_url }),
					})),
			]
			return { status: progress, failures }
		}),
	]
}

/** Checks take a while to appear after a push: a commit with none yet is not a commit whose checks all passed. */
function checksStatus(runs: readonly { status: string }[], commitStatuses: readonly { state: string }[]): ChecksStatus {
	if (runs.length === 0 && commitStatuses.length === 0) return 'none'
	const pending = runs.some((run) => run.status !== 'completed') || commitStatuses.some((commitStatus) => commitStatus.state === 'pending')
	return pending ? 'pending' : 'completed'
}

function itemId(kind: ReviewItemKind, id: number): string {
	return `${kind}/${String(id)}`
}

function parseItemId(item: string): { kind: ReviewItemKind; id: number } {
	const [kind, id] = item.split('/')
	return { kind: ReviewItemKind.parse(kind), id: z.coerce.number().int().parse(id) }
}
