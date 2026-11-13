import { z } from 'zod'

/** A request the fake was sent. */
export interface FakeRequest {
	readonly method: string
	readonly path: string
	readonly query: URLSearchParams
	readonly authorization: string | null
	readonly body: unknown
	/** The request's signal, so a test sees that a stopped call stopped its request. */
	readonly signal: AbortSignal | undefined
}

/** A comment on a fake issue. */
export interface FakeComment {
	id: string
	author: string
	created: string
	/** What a comment body renders as: its HTML. */
	html: string
	/** What was posted: ADF on Cloud, wiki markup on Data Center. */
	posted?: unknown
}

/** An issue the fake holds, in the shape tests arrange it in rather than Jira's. */
export interface FakeIssue {
	key: string
	summary: string
	type: string
	status: string
	labels: string[]
	descriptionHtml: string
	comments: FakeComment[]
	/** The statuses the issue's workflow can move to from any status, by transition id. */
	transitions: Record<string, string>
	properties: Record<string, unknown>
	links: { type: { inward: string; outward: string }; inwardIssue?: FakeNestedIssue; outwardIssue?: FakeNestedIssue }[]
	attachments: FakeAttachment[]
}

/** A file attached to a fake issue, served at `/secure/attachment/<id>/<filename>` unless `content` says otherwise. */
export interface FakeAttachment {
	id: string
	filename: string
	mimeType: string
	bytes: Uint8Array
	/** Where Jira says the bytes are; by default on the site. */
	content?: string
}

/** An issue as a link names it: its key, summary and status. */
interface FakeNestedIssue {
	key: string
	fields: { summary: string; status: { name: string } }
}

/** A Confluence page the fake holds. */
export interface FakePage {
	id: string
	title: string
	space: string
	html: string
	version: number
}

/** What a test arranges the fake with, and what it saw. */
export interface FakeAtlassian {
	readonly fetch: typeof fetch
	readonly requests: FakeRequest[]
	readonly issues: Map<string, FakeIssue>
	readonly pages: Map<string, FakePage>
	/** The people Jira and Confluence know, by account id or username. Without an email, the site keeps it private. */
	readonly users: Map<string, { displayName: string; email?: string }>
	/** Paths whose requests never get an answer, until their signal aborts: a site that hangs. */
	readonly hanging: Set<string>
	/** Answers the next requests with these statuses, oldest first, before serving as usual: a site that has trouble. */
	readonly failNext: number[]
	/** Requests, as `METHOD /path`, that are served but answered 504: an answer a proxy lost. */
	readonly losesAnswers: Set<string>
	/** How long each answer takes, in milliseconds: room for calls to interleave. */
	latencyMs: number
}

/** An issue with the defaults filled in. */
export function fakeIssue(issue: Partial<FakeIssue> & { key: string }): FakeIssue {
	return {
		summary: 'Login fails on Safari',
		type: 'Story',
		status: 'To Do',
		labels: [],
		descriptionHtml: '<p>Steps: <strong>open</strong> the login page.</p>',
		comments: [],
		transitions: { '11': 'To Do', '21': 'In Progress', '31': 'Done' },
		properties: {},
		links: [],
		attachments: [],
		...issue,
	}
}

const SearchBody = z.object({ jql: z.string() })
const TransitionBody = z.object({ transition: z.object({ id: z.string() }) })
const CommentBody = z.object({ body: z.unknown() })

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const noContent = () => new Response(null, { status: 204 })
const notFound = () => json(404, { errorMessages: ['Not found'] })

/**
 * Jira and Confluence in one `fetch`, on Cloud's and Data Center's paths alike: `/rest/api/3` and
 * `/rest/api/2` for Jira, `/wiki/rest/api` and `/rest/api` for Confluence. Holds just enough to
 * answer the connector's calls.
 */
export function fakeAtlassian(): FakeAtlassian {
	const requests: FakeRequest[] = []
	const issues = new Map<string, FakeIssue>()
	const pages = new Map<string, FakePage>()
	const users = new Map<string, { displayName: string; email?: string }>()
	const hanging = new Set<string>()
	const failNext: number[] = []
	const losesAnswers = new Set<string>()
	let nextCommentId = 10_000

	const user = (query: URLSearchParams, email: 'emailAddress' | 'email'): Response => {
		const found = users.get(query.get('accountId') ?? query.get('username') ?? '')
		return found === undefined
			? notFound()
			: json(200, { displayName: found.displayName, ...(found.email === undefined ? {} : { [email]: found.email }) })
	}

	const serveJira = (method: string, route: string, query: URLSearchParams, body: unknown): Response => {
		if (method === 'GET' && route === '/user') return user(query, 'emailAddress')
		if (method === 'POST' && route === '/search/jql') return search(SearchBody.parse(body).jql, 'cloud')
		if (method === 'GET' && route === '/search') return search(query.get('jql') ?? '', 'data-center')
		const match = /^\/issue\/([^/]+)(\/.*)?$/.exec(route)
		const issue = match?.[1] === undefined ? undefined : issues.get(match[1])
		if (issue === undefined) return notFound()
		const rest = match?.[2] ?? ''
		if (method === 'GET' && rest === '') return json(200, rendered(issue))
		if (method === 'GET' && rest === '/transitions')
			return json(200, {
				transitions: Object.entries(issue.transitions)
					.filter(([, to]) => to !== issue.status)
					.map(([id, to]) => ({ id, name: `Move to ${to}`, to: { name: to } })),
			})
		if (method === 'POST' && rest === '/transitions') {
			const id = TransitionBody.parse(body).transition.id
			const to = issue.transitions[id]
			if (to === undefined) return json(400, { errorMessages: ['No such transition'] })
			issue.status = to
			return noContent()
		}
		if (method === 'POST' && rest === '/comment') {
			const comment = {
				id: String(nextCommentId++),
				author: 'mesh-flow',
				created: '2026-11-12T10:00:00.000Z',
				html: '',
				posted: CommentBody.parse(body).body,
			}
			issue.comments.push(comment)
			return json(201, { id: comment.id })
		}
		const commentMatch = /^\/comment\/(\d+)$/.exec(rest)
		if (method === 'PUT' && commentMatch !== null) {
			const comment = issue.comments.find((candidate) => candidate.id === commentMatch[1])
			if (comment === undefined) return notFound()
			comment.posted = CommentBody.parse(body).body
			return json(200, { id: comment.id })
		}
		const propertyMatch = /^\/properties\/(.+)$/.exec(rest)
		if (propertyMatch?.[1] !== undefined) {
			const name = decodeURIComponent(propertyMatch[1])
			if (method === 'PUT') {
				issue.properties[name] = body
				return noContent()
			}
			return name in issue.properties ? json(200, { key: name, value: issue.properties[name] }) : notFound()
		}
		return notFound()
	}

	const search = (jql: string, deployment: 'cloud' | 'data-center'): Response => {
		const project = /project = (\w+)/.exec(jql)?.[1]
		const found = [...issues.values()]
			.filter((issue) => project === undefined || issue.key.startsWith(`${project}-`))
			.map((issue) => ({
				key: issue.key,
				fields: { summary: issue.summary, status: { name: issue.status }, issuetype: { name: issue.type } },
			}))
		return deployment === 'cloud' ? json(200, { issues: found, isLast: true }) : json(200, { issues: found, total: found.length })
	}

	const serveConfluence = (route: string, query: URLSearchParams): Response => {
		if (route === '/user') return user(query, 'email')
		if (route === '/search') {
			const text = /text ~ "([^"]*)"/.exec(query.get('cql') ?? '')?.[1] ?? ''
			const found = [...pages.values()].filter((page) => page.html.includes(text) || page.title.includes(text))
			// As `/rest/api/search` answers: the content under `content`, the highlighted excerpt next to it.
			return json(200, {
				results: found.map((page) => ({
					content: pageAnswer(page),
					excerpt: query.get('excerpt') === 'highlight' ? `@@@hl@@@${text}@@@endhl@@@ and more` : `${text} and more`,
					url: `/spaces/${page.space}/pages/${page.id}`,
				})),
				_links: {},
			})
		}
		const page = pages.get(/^\/content\/(\d+)$/.exec(route)?.[1] ?? '')
		return page === undefined ? notFound() : json(200, { ...pageAnswer(page), body: { view: { value: page.html } } })
	}

	const fake: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		const method = init?.method ?? 'GET'
		const text = typeof init?.body === 'string' ? init.body : undefined
		const headers = new Headers(init?.headers)
		const body: unknown = text === undefined ? undefined : JSON.parse(text)
		requests.push({
			method,
			path: url.pathname,
			query: url.searchParams,
			authorization: headers.get('authorization'),
			body,
			signal: init?.signal ?? undefined,
		})
		if (state.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, state.latencyMs))
		if (hanging.has(url.pathname))
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(init.signal?.reason)
				})
			})
		const failure = failNext.shift()
		if (failure !== undefined) return json(failure, { errorMessages: ['Trouble'] })
		const attachmentId = /^\/secure\/attachment\/(\d+)\//.exec(url.pathname)?.[1]
		if (attachmentId !== undefined) {
			const attachment = [...issues.values()].flatMap((issue) => issue.attachments).find(({ id }) => id === attachmentId)
			return attachment === undefined ? notFound() : new Response(attachment.bytes, { headers: { 'content-type': attachment.mimeType } })
		}
		const jira = /^\/rest\/api\/[23](\/.*)$/.exec(url.pathname)?.[1]
		const confluence = /^(?:\/wiki|\/confluence)?\/rest\/api(\/(?:content|search|user).*)$/.exec(url.pathname)?.[1]
		const served =
			confluence !== undefined
				? serveConfluence(confluence, url.searchParams)
				: jira === undefined
					? notFound()
					: serveJira(method, jira, url.searchParams, body)
		return losesAnswers.has(`${method} ${url.pathname}`) ? json(504, { errorMessages: ['Gateway timeout'] }) : served
	}

	const state: FakeAtlassian = { fetch: fake, requests, issues, pages, users, hanging, failNext, losesAnswers, latencyMs: 0 }
	return state
}

function rendered(issue: FakeIssue) {
	return {
		key: issue.key,
		fields: {
			summary: issue.summary,
			issuetype: { name: issue.type },
			status: { name: issue.status },
			priority: { name: 'High' },
			assignee: null,
			reporter: { displayName: 'Rita Reporter' },
			labels: issue.labels,
			components: [{ name: 'web' }],
			created: '2026-11-10T09:00:00.000Z',
			updated: '2026-11-11T09:00:00.000Z',
			comment: {
				comments: issue.comments.map((comment) => ({ id: comment.id, author: { displayName: comment.author }, created: comment.created })),
			},
			issuelinks: issue.links,
			subtasks: [],
			attachment: issue.attachments.map((attachment) => ({
				id: attachment.id,
				filename: attachment.filename,
				mimeType: attachment.mimeType,
				size: attachment.bytes.byteLength,
				content: attachment.content ?? `/secure/attachment/${attachment.id}/${attachment.filename}`,
			})),
		},
		renderedFields: {
			description: issue.descriptionHtml,
			comment: { comments: issue.comments.map((comment) => ({ id: comment.id, body: comment.html })) },
		},
	}
}

function pageAnswer(page: FakePage) {
	return {
		id: page.id,
		title: page.title,
		space: { key: page.space },
		version: { number: page.version, when: '2026-11-01T12:00:00.000Z' },
		_links: { webui: `/spaces/${page.space}/pages/${page.id}` },
	}
}
