import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { z } from 'zod'
import { splitRepositoryName } from '../repository-name.mts'
import { commentMarker, isMarked, type PostedComment } from '../tools/issue-tools.mts'
import {
	checksOnRef,
	type ChecksStatus,
	getPullRequest,
	markSeen,
	openPullRequest,
	replyToReviewItem,
	reviewActivity,
	ReviewItemKind,
	type CheckFailure,
	type PullRequestData,
	type ReviewItem,
} from '../tools/pull-request-tools.mts'
import type { Octokit } from '@octokit/rest'
import type { ApiClient } from './api.mts'
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

/** Left in every reply this package posts, so a look at the review never hands it back as a reviewer's. */
const replyMarker = commentMarker('reply')

/** The reaction that says a comment was read. */
const seenReaction = 'eyes'

/** Marks the reply that says `item` is being read, until the answer replaces it. */
const seenMarker = (item: string) => commentMarker(`seen:${item}`)

/** Marks the reply that says an item is being read with the 👀 reaction it put on the item, which the answer takes off. */
const reactionMarker = (reaction: number) => commentMarker(`reaction:${String(reaction)}`)

/** Finds the reaction in a reply that says an item is being read. */
const reactionInMarker = /<!-- mesh-flow:reaction:(\d+) -->/

/** Marks the answer that replaced the reply that said `item` was being read, so `item` isn't marked again. */
const answeredMarker = (item: string) => commentMarker(`answered:${item}`)

const secondMs = 1_000

/** The latest of two moments, either of which may be missing. */
function later(seen: string | undefined, latest: string | undefined): string | undefined {
	if (seen === undefined) return latest
	if (latest === undefined) return seen
	return seen.localeCompare(latest) >= 0 ? seen : latest
}

/** The host halves of the pull request tools. */
export function pullRequestHostTools(api: ApiClient): HostTool[] {
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
					per_page: 100,
					...listSince,
				}),
				client.paginate(client.rest.pulls.listReviews, { ...where, pull_number: number, per_page: 100 }),
				client.paginate(client.rest.issues.listComments, {
					...where,
					issue_number: number,
					per_page: 100,
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

		hostTool(replyToReviewItem, async ({ repository, number, item, body }, context) => {
			const client = await api(context)
			const thread = threadOf(client, repository, number)
			const { kind, id } = parseItemId(item)
			const placeholder = await thread.find(kind, [seenMarker(item)])
			if (placeholder === undefined)
				return thread.post(kind === 'review-comment' ? id : undefined, signed(body, context.runId, [replyMarker]))
			const answer = await thread.edit(kind, placeholder.id, signed(body, context.runId, [replyMarker, answeredMarker(item)]))
			// Answered: the 👀 the item got when it was read comes off again.
			const reaction = reactionInMarker.exec(placeholder.body)?.[1]
			if (reaction !== undefined) await thread.unreact(kind, id, Number(reaction))
			return answer
		}),

		hostTool(markSeen, async ({ repository, number, items }, context) => {
			const client = await api(context)
			const thread = threadOf(client, repository, number)
			// One at a time: GitHub limits bursts of writes, and a round of review can bring many items.
			for (const { id: item, url, thread: root } of items) {
				const { kind, id } = parseItemId(item)
				const reaction = await thread.react(kind, id)
				if ((await thread.find(kind, [seenMarker(item), answeredMarker(item)])) !== undefined) continue
				// A thread of line comments only takes replies to its first comment.
				const replyTo = kind === 'review-comment' ? parseItemId(root ?? item).id : undefined
				const reading = kind === 'review-comment' ? '👀 Reading...' : `👀 Reading [this ${kind}](${url})...`
				const reactionMarkers = reaction === undefined ? [] : [reactionMarker(reaction)]
				await thread.post(replyTo, signed(reading, context.runId, [replyMarker, seenMarker(item), ...reactionMarkers]))
			}
			return { marked: items.map((item) => item.id) }
		}),

		hostTool(checksOnRef, async ({ repository, ref }, context) => {
			const client = await api(context)
			const where = splitRepositoryName(repository)
			const [runs, combined] = await Promise.all([
				client.paginate(client.rest.checks.listForRef, { ...where, ref, per_page: 100 }),
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

/** What the connector says about a comment it posted or edited. */
function posted(data: { id: number; html_url: string }): PostedComment {
	return { id: data.id, url: data.html_url }
}

/**
 * Where the connector answers a review item: in the thread of a comment on a line, or on the
 * pull request's conversation for everything else.
 */
function threadOf(client: Octokit, repository: string, number: number) {
	const where = splitRepositoryName(repository)
	const conversation = { ...where, issue_number: number }
	return {
		/** The first comment the connector posted where `kind` is answered that carries one of `markers`. */
		async find(kind: ReviewItemKind, markers: readonly string[]): Promise<{ id: number; body: string } | undefined> {
			const hasMarker = (body: string | null | undefined) => markers.some((marker) => body?.includes(marker) === true)
			const comments =
				kind === 'review-comment'
					? await client.paginate(client.rest.pulls.listReviewComments, { ...where, pull_number: number, per_page: 100 })
					: await client.paginate(client.rest.issues.listComments, { ...conversation, per_page: 100 })
			const found = comments.find((comment) => hasMarker(comment.body))
			return found === undefined ? undefined : { id: found.id, body: found.body ?? '' }
		},
		/** Puts 👀 on item `id` and returns the reaction's id; GitHub takes no reactions on a review. */
		async react(kind: ReviewItemKind, id: number): Promise<number | undefined> {
			const reaction = { ...where, comment_id: id, content: seenReaction } as const
			if (kind === 'review-comment') return (await client.rest.reactions.createForPullRequestReviewComment(reaction)).data.id
			if (kind === 'comment') return (await client.rest.reactions.createForIssueComment(reaction)).data.id
			return undefined
		},
		async unreact(kind: ReviewItemKind, id: number, reaction: number): Promise<void> {
			if (kind === 'review-comment')
				await client.rest.reactions.deleteForPullRequestComment({ ...where, comment_id: id, reaction_id: reaction })
			if (kind === 'comment') await client.rest.reactions.deleteForIssueComment({ ...where, comment_id: id, reaction_id: reaction })
		},
		/** Replies in the thread of line comment `replyTo`, or on the conversation without one. */
		async post(replyTo: number | undefined, body: string) {
			if (replyTo !== undefined)
				return posted(
					(await client.rest.pulls.createReplyForReviewComment({ ...where, pull_number: number, comment_id: replyTo, body })).data,
				)
			return posted((await client.rest.issues.createComment({ ...conversation, body })).data)
		},
		async edit(kind: ReviewItemKind, comment: number, body: string) {
			if (kind === 'review-comment')
				return posted((await client.rest.pulls.updateReviewComment({ ...where, comment_id: comment, body })).data)
			return posted((await client.rest.issues.updateComment({ ...where, comment_id: comment, body })).data)
		},
	}
}

function itemId(kind: ReviewItemKind, id: number): string {
	return `${kind}/${String(id)}`
}

function parseItemId(item: string): { kind: ReviewItemKind; id: number } {
	const [kind, id] = item.split('/')
	return { kind: ReviewItemKind.parse(kind), id: z.coerce.number().int().parse(id) }
}
