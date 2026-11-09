import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { z } from 'zod'
import { splitRepositoryName } from '../repository-name.mts'
import {
	checksOnRef,
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

/** The host halves of the pull request tools. */
export function pullRequestHostTools(api: ApiClient): HostTool[] {
	/** Who the token belongs to, found once per process. `undefined` when the token can't say, as an installation token can't. */
	let self: Promise<string | undefined> | undefined

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
			const until = new Date().toISOString()
			const after = since === undefined ? undefined : new Date(since).getTime()
			const isNew = (at: string | null | undefined): at is string =>
				at !== null && at !== undefined && (after === undefined || new Date(at).getTime() > after)
			self ??= client.rest.users.getAuthenticated().then(
				({ data }) => data.login,
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
					.filter((comment) => isNew(comment.created_at))
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
					.filter((review) => isNew(review.submitted_at) && (review.body !== '' || review.state !== 'COMMENTED'))
					.map((review) => ({
						id: itemId('review', review.id),
						kind: 'review' as const,
						author: review.user?.login ?? '',
						body: review.body,
						url: review.html_url,
						at: review.submitted_at ?? until,
						...(verdicts[review.state] === undefined ? {} : { verdict: verdicts[review.state] }),
					})),
				...comments
					.filter((comment) => isNew(comment.created_at))
					.map((comment) => ({
						id: itemId('comment', comment.id),
						kind: 'comment' as const,
						author: comment.user?.login ?? '',
						body: comment.body ?? '',
						url: comment.html_url,
						at: comment.created_at,
					})),
			].toSorted((a, b) => a.at.localeCompare(b.at))
			const login = await self
			return { ...(login === undefined ? {} : { self: login }), items, until }
		}),

		hostTool(replyToReviewItem, async ({ repository, number, item, body }, context) => {
			const client = await api(context)
			const where = splitRepositoryName(repository)
			const { kind, id } = parseItemId(item)
			if (kind === 'review-comment') {
				const { data } = await client.rest.pulls.createReplyForReviewComment({ ...where, pull_number: number, comment_id: id, body })
				return { id: data.id, url: data.html_url }
			}
			const { data } = await client.rest.issues.createComment({ ...where, issue_number: number, body })
			return { id: data.id, url: data.html_url }
		}),

		hostTool(checksOnRef, async ({ repository, ref }, context) => {
			const client = await api(context)
			const where = splitRepositoryName(repository)
			const [runs, combined] = await Promise.all([
				client.paginate(client.rest.checks.listForRef, { ...where, ref, per_page: 100 }),
				client.rest.repos.getCombinedStatusForRef({ ...where, ref }),
			])
			const pending = runs.some((run) => run.status !== 'completed') || combined.data.statuses.some((status) => status.state === 'pending')
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
			return { status: pending ? 'pending' : 'completed', failures }
		}),
	]
}

function itemId(kind: ReviewItemKind, id: number): string {
	return `${kind}/${String(id)}`
}

function parseItemId(item: string): { kind: ReviewItemKind; id: number } {
	const [kind, id] = item.split('/')
	return { kind: ReviewItemKind.parse(kind), id: z.coerce.number().int().parse(id) }
}
