import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { onTestFinished } from 'vitest'
import { z } from 'zod'

/** A comment on an issue or a pull request's conversation. */
export interface FakeComment {
	id: number
	body: string
	user: { login: string }
	html_url: string
	created_at: string
	/** The reactions put on it, such as `eyes`. */
	reactions?: { id: number; content: string }[]
}

export interface FakeReviewComment extends FakeComment {
	path: string
	line: number | null
	in_reply_to_id?: number
}

export interface FakeReview {
	id: number
	body: string
	state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
	user: { login: string }
	html_url: string
	submitted_at: string
}

export interface FakeIssue {
	number: number
	title: string
	body: string | null
	state: 'open' | 'closed'
	labels: { name: string }[]
	user: { login: string }
	html_url: string
	created_at: string
	comments: FakeComment[]
}

export interface FakePullRequest {
	number: number
	title: string
	body: string
	state: 'open' | 'closed'
	merged: boolean
	html_url: string
	head: { ref: string; sha: string }
	base: { ref: string }
	comments: FakeComment[]
	reviewComments: FakeReviewComment[]
	reviews: FakeReview[]
}

export interface FakeCheckRun {
	name: string
	status: 'queued' | 'in_progress' | 'completed'
	conclusion: string | null
	html_url: string | null
	output: { title: string | null; summary: string | null }
}

/** What the fake holds for one repository. */
export interface FakeRepository {
	issues: Map<number, FakeIssue>
	pulls: Map<number, FakePullRequest>
	/** Check runs per commit. */
	checks: Map<string, FakeCheckRun[]>
}

/** Enough of GitHub's REST API for the connector's host tools, in memory. */
export interface FakeGithub {
	readonly url: string
	/** The login the token belongs to. */
	readonly self: string
	/** How many of the next requests answer 503, as GitHub does while it's down. */
	unavailableRequests: number
	/** The tokens that were sent in `Authorization` headers. */
	readonly tokens: Set<string>
	repository(name: string): FakeRepository
	issue(repository: string, number: number, fields?: Partial<FakeIssue>): FakeIssue
	pullRequest(repository: string, number: number, fields?: Partial<FakePullRequest>): FakePullRequest
	close(): Promise<void>
}

const siteUrl = 'https://github.example'

const now = () => new Date().toISOString()
const issueJson = (issue: FakeIssue) => ({ ...issue, comments: issue.comments.length })

interface RouteContext {
	req: { param: (name: string) => string | undefined }
}
const nameOf = (context: RouteContext) => `${context.req.param('owner') ?? ''}/${context.req.param('repo') ?? ''}`
const numberOf = (context: RouteContext) => Number(context.req.param('number'))

const pullJson = (pull: FakePullRequest) => ({
	number: pull.number,
	title: pull.title,
	body: pull.body,
	state: pull.state,
	merged: pull.merged,
	merged_at: pull.merged ? now() : null,
	html_url: pull.html_url,
	head: pull.head,
	base: pull.base,
})

const StateBody = z.object({ state: z.enum(['open', 'closed']).optional() })
const LabelsBody = z.object({ labels: z.array(z.string()) })
const CommentBody = z.object({ body: z.string() })
const PullBody = z.object({ head: z.string(), base: z.string(), title: z.string(), body: z.string() })

export async function fakeGithub(): Promise<FakeGithub> {
	const repositories = new Map<string, FakeRepository>()
	const tokens = new Set<string>()
	const self = 'mesh-flow-bot'
	let nextId = 1000
	const id = () => ++nextId

	const repository = (name: string): FakeRepository => {
		const known = repositories.get(name)
		if (known !== undefined) return known
		const made: FakeRepository = { issues: new Map(), pulls: new Map(), checks: new Map() }
		repositories.set(name, made)
		return made
	}
	const issueOf = (name: string, number: number, fields: Partial<FakeIssue> = {}): FakeIssue => {
		const repo = repository(name)
		const known = repo.issues.get(number)
		if (known !== undefined) return Object.assign(known, fields)
		const made: FakeIssue = {
			number,
			title: `Issue ${String(number)}`,
			body: '',
			state: 'open',
			labels: [],
			user: { login: 'reporter' },
			html_url: `${siteUrl}/${name}/issues/${String(number)}`,
			created_at: now(),
			comments: [],
			...fields,
		}
		repo.issues.set(number, made)
		return made
	}
	const pullOf = (name: string, number: number, fields: Partial<FakePullRequest> = {}): FakePullRequest => {
		const repo = repository(name)
		const known = repo.pulls.get(number)
		if (known !== undefined) return Object.assign(known, fields)
		const made: FakePullRequest = {
			number,
			title: `Pull request ${String(number)}`,
			body: '',
			state: 'open',
			merged: false,
			html_url: `${siteUrl}/${name}/pull/${String(number)}`,
			head: { ref: 'feature', sha: '0'.repeat(40) },
			base: { ref: 'main' },
			comments: [],
			reviewComments: [],
			reviews: [],
			...fields,
		}
		repo.pulls.set(number, made)
		return made
	}

	const settings = { unavailableRequests: 0 }
	const app = new Hono()
	app.use(async (context, next) => {
		const authorization = context.req.header('authorization')
		if (authorization === undefined) return context.json({ message: 'Requires authentication' }, 401)
		tokens.add(authorization.replace(/^(token|Bearer) /, ''))
		if (settings.unavailableRequests > 0) {
			settings.unavailableRequests--
			return context.json({ message: 'Service Unavailable' }, 503)
		}
		return next()
	})
	app.get('/user', (context) => context.json({ login: self }))

	const issues = new Hono().basePath('/repos/:owner/:repo')
	issues.get('/issues/:number', (context) => {
		const issue = repository(nameOf(context)).issues.get(numberOf(context))
		return issue === undefined ? context.json({ message: 'Not Found' }, 404) : context.json(issueJson(issue))
	})
	issues.patch('/issues/:number', async (context) => {
		const issue = issueOf(nameOf(context), numberOf(context))
		const body = StateBody.parse(await context.req.json())
		if (body.state !== undefined) issue.state = body.state
		return context.json(issueJson(issue))
	})
	issues.post('/issues/:number/labels', async (context) => {
		const issue = issueOf(nameOf(context), numberOf(context))
		const body = LabelsBody.parse(await context.req.json())
		for (const name of body.labels) if (!issue.labels.some((label) => label.name === name)) issue.labels.push({ name })
		return context.json(issue.labels)
	})
	/** Comments on an issue, or on a pull request's conversation, which GitHub keeps as issue comments. */
	const conversationOf = (name: string, number: number): FakeComment[] =>
		repository(name).pulls.get(number)?.comments ?? issueOf(name, number).comments
	issues.get('/issues/:number/comments', (context) => context.json(conversationOf(nameOf(context), numberOf(context))))
	issues.post('/issues/:number/comments', async (context) => {
		const name = nameOf(context)
		const number = numberOf(context)
		const body = CommentBody.parse(await context.req.json())
		const comment: FakeComment = {
			id: id(),
			body: body.body,
			user: { login: self },
			html_url: `${siteUrl}/${name}/issues/${String(number)}#issuecomment-${String(nextId)}`,
			created_at: now(),
		}
		conversationOf(name, number).push(comment)
		return context.json(comment, 201)
	})
	issues.patch('/issues/comments/:id', async (context) => {
		const wanted = Number(context.req.param('id'))
		const repo = repository(nameOf(context))
		const all = [
			...[...repo.issues.values()].flatMap((issue) => issue.comments),
			...[...repo.pulls.values()].flatMap((pull) => pull.comments),
		]
		const comment = all.find((known) => known.id === wanted)
		if (comment === undefined) return context.json({ message: 'Not Found' }, 404)
		comment.body = CommentBody.parse(await context.req.json()).body
		return context.json(comment)
	})

	issues.get('/pulls', (context) => {
		const head = context.req.query('head')?.split(':')[1]
		const state = context.req.query('state') ?? 'open'
		const found = [...repository(nameOf(context)).pulls.values()].filter(
			(pull) => (state === 'all' || pull.state === state) && (head === undefined || pull.head.ref === head),
		)
		return context.json(found.map(pullJson))
	})
	issues.post('/pulls', async (context) => {
		const name = nameOf(context)
		const body = PullBody.parse(await context.req.json())
		const number = repository(name).pulls.size + 1
		const pull = pullOf(name, number, {
			title: body.title,
			body: body.body,
			head: { ref: body.head, sha: shaOf(body.head) },
			base: { ref: body.base },
		})
		return context.json(pullJson(pull), 201)
	})
	issues.get('/pulls/:number', (context) => {
		const pull = repository(nameOf(context)).pulls.get(numberOf(context))
		return pull === undefined ? context.json({ message: 'Not Found' }, 404) : context.json(pullJson(pull))
	})
	issues.get('/pulls/:number/comments', (context) => context.json(pullOf(nameOf(context), numberOf(context)).reviewComments))
	issues.get('/pulls/:number/reviews', (context) => context.json(pullOf(nameOf(context), numberOf(context)).reviews))
	issues.post('/pulls/:number/comments/:id/replies', async (context) => {
		const name = nameOf(context)
		const pull = pullOf(name, numberOf(context))
		const parent = pull.reviewComments.find((known) => known.id === Number(context.req.param('id')))
		if (parent === undefined) return context.json({ message: 'Not Found' }, 404)
		const body = CommentBody.parse(await context.req.json())
		const comment: FakeReviewComment = {
			id: id(),
			body: body.body,
			user: { login: self },
			html_url: `${pull.html_url}#discussion_r${String(nextId)}`,
			created_at: now(),
			path: parent.path,
			line: parent.line,
			in_reply_to_id: parent.id,
		}
		pull.reviewComments.push(comment)
		return context.json(comment, 201)
	})
	issues.patch('/pulls/comments/:id', async (context) => {
		const wanted = Number(context.req.param('id'))
		const comment = [...repository(nameOf(context)).pulls.values()]
			.flatMap((pull) => pull.reviewComments)
			.find((known) => known.id === wanted)
		if (comment === undefined) return context.json({ message: 'Not Found' }, 404)
		comment.body = CommentBody.parse(await context.req.json()).body
		return context.json(comment)
	})
	const ReactionBody = z.object({ content: z.string() })
	const reviewCommentsOf = (name: string) => [...repository(name).pulls.values()].flatMap((pull) => pull.reviewComments)
	const issueCommentsOf = (name: string): FakeComment[] => {
		const repo = repository(name)
		return [...[...repo.issues.values()].flatMap((issue) => issue.comments), ...[...repo.pulls.values()].flatMap((pull) => pull.comments)]
	}
	/** Puts a reaction on a comment once, as GitHub does: a second one of the same kind is the first. */
	const react = async (context: Context, comments: readonly FakeComment[]) => {
		const comment = comments.find((known) => known.id === Number(context.req.param('id')))
		if (comment === undefined) return context.json({ message: 'Not Found' }, 404)
		const { content } = ReactionBody.parse(await context.req.json())
		comment.reactions ??= []
		const reaction = comment.reactions.find((known) => known.content === content) ?? { id: id(), content }
		if (!comment.reactions.includes(reaction)) comment.reactions.push(reaction)
		return context.json({ ...reaction, user: { login: self } }, 201)
	}
	issues.post('/pulls/comments/:id/reactions', (context) => react(context, reviewCommentsOf(nameOf(context))))
	issues.post('/issues/comments/:id/reactions', (context) => react(context, issueCommentsOf(nameOf(context))))
	issues.delete('/pulls/comments/:id/reactions/:reaction', (context) => unreact(context, reviewCommentsOf(nameOf(context))))
	issues.delete('/issues/comments/:id/reactions/:reaction', (context) => unreact(context, issueCommentsOf(nameOf(context))))
	issues.get('/commits/:ref/check-runs', (context) => {
		const runs = repository(nameOf(context)).checks.get(context.req.param('ref')) ?? []
		return context.json({ total_count: runs.length, check_runs: runs })
	})
	issues.get('/commits/:ref/status', (context) => context.json({ state: 'success', statuses: [] }))
	app.route('/', issues)
	app.notFound((context) => context.json({ message: `No route for ${context.req.method} ${context.req.path}` }, 404))

	const listener = getRequestListener(app.fetch)
	const server = createServer((request, response) => {
		void listener(request, response)
	})
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('The fake has no port.')
	const close = () =>
		new Promise<void>((resolve) => {
			server.close(() => {
				resolve()
			})
			server.closeAllConnections()
		})
	onTestFinished(close)
	return {
		url: `http://127.0.0.1:${String(address.port)}`,
		self,
		get unavailableRequests() {
			return settings.unavailableRequests
		},
		set unavailableRequests(requests: number) {
			settings.unavailableRequests = requests
		},
		tokens,
		repository,
		issue: issueOf,
		pullRequest: pullOf,
		close,
	}
}

/** Takes a reaction off a comment, as GitHub does. */
function unreact(context: Context, comments: readonly FakeComment[]) {
	const comment = comments.find((known) => known.id === Number(context.req.param('id')))
	const wanted = Number(context.req.param('reaction'))
	if (comment?.reactions?.some((known) => known.id === wanted) !== true) return context.json({ message: 'Not Found' }, 404)
	comment.reactions = comment.reactions.filter((known) => known.id !== wanted)
	return context.body(null, 204)
}

/** A commit id for a branch name, the same every time. */
export function shaOf(branch: string): string {
	return Buffer.from(branch).toString('hex').padEnd(40, '0').slice(0, 40)
}
