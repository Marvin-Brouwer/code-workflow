import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { z } from 'zod'
import { splitRepositoryName } from '../repository-name.mts'
import { commentMarker, isMarked } from '../tools/issue-tools.mts'
import {
	checksOnRef,
	type ChecksStatus,
	getPullRequest,
	openPullRequest,
	replyToReviewItem,
	reviewActivity,
	ReviewItemKind,
	type CheckFailure,
	type PullRequestData,
	type ReviewItem,
} from '../tools/pull-request-tools.mts'
import type { ApiClient } from './api.mts'

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

/** The latest of two moments, either of which may be missing. */
function later(a: string | undefined, b: string | undefined): string | undefined {
	if (a === undefined) return b
	if (b === undefined) return a
	return a.localeCompare(b) >= 0 ? a : b
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
			// At or after: GitHub keeps seconds, so a comment in the same second as the last one seen would be lost otherwise.
			const isNew = (at: string | null | undefined): at is string =>
				at !== null && at !== undefined && (after === undefined || new Date(at).getTime() >= after)
			// Found on every look, never kept: the token can change hands, and a failed lookup is not an answer.
			const self = client.rest.users.getAuthenticated().then(
				({ data }): string | undefined => data.login,
				() => undefined,
			)
			const [lineComments, reviews, comments] = await Promise.all([
				client.paginate(client.rest.pulls.listReviewComments, {
					...where,
					pull_number: number,
					per_page: 100,
					...(since === undefined ? {} : { since }),
				}),
				client.paginate(client.rest.pulls.listReviews, { ...where, pull_number: number, per_page: 100 }),
				client.paginate(client.rest.issues.listComments, {
					...where,
					issue_number: number,
					per_page: 100,
					...(since === undefined ? {} : { since }),
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
			const login = await self
			return { ...(login === undefined ? {} : { self: login }), items, ...(until === undefined ? {} : { until }) }
		}),

		hostTool(replyToReviewItem, async ({ repository, number, item, body }, context) => {
			const client = await api(context)
			const where = splitRepositoryName(repository)
			const { kind, id } = parseItemId(item)
			const marked = `${body}\n\n${replyMarker}`
			if (kind === 'review-comment') {
				const { data } = await client.rest.pulls.createReplyForReviewComment({
					...where,
					pull_number: number,
					comment_id: id,
					body: marked,
				})
				return { id: data.id, url: data.html_url }
			}
			const { data } = await client.rest.issues.createComment({ ...where, issue_number: number, body: marked })
			return { id: data.id, url: data.html_url }
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

function itemId(kind: ReviewItemKind, id: number): string {
	return `${kind}/${String(id)}`
}

function parseItemId(item: string): { kind: ReviewItemKind; id: number } {
	const [kind, id] = item.split('/')
	return { kind: ReviewItemKind.parse(kind), id: z.coerce.number().int().parse(id) }
}
