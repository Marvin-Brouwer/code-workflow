import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { onTestFinished } from 'vitest'
import { z } from 'zod'

/** An award emoji on a note, such as the 👀 `eyes`. */
export interface FakeAward {
	id: number
	name: string
	user: { username: string }
}

/** A note in a discussion of a merge request. */
export interface FakeNote {
	id: number
	type: 'DiffNote' | 'DiscussionNote' | null
	body: string
	author: { username: string }
	created_at: string
	system: boolean
	position?: { new_path: string; new_line: number }
	awards: FakeAward[]
}

/** A thread of notes, or a note on its own. */
export interface FakeDiscussion {
	id: string
	notes: FakeNote[]
}

export interface FakeMergeRequest {
	iid: number
	title: string
	description: string | null
	state: 'opened' | 'closed' | 'merged' | 'locked'
	web_url: string
	source_branch: string
	target_branch: string
	sha: string
	merge_commit_sha: string | null
	discussions: FakeDiscussion[]
}

export interface FakeJob {
	name: string
	stage: string
	status: string
	web_url: string
	failure_reason?: string
	allow_failure?: boolean
}

export interface FakePipeline {
	id: number
	sha: string
	ref: string
	status: string
	web_url: string
	jobs: FakeJob[]
}

export interface FakePackage {
	name: string
	version: string
	package_type: string
	pipeline_id: number
}

/** What the fake holds for one project. */
export interface FakeProject {
	path: string
	name: string
	description: string
	mergeRequests: Map<number, FakeMergeRequest>
	pipelines: FakePipeline[]
	packages: FakePackage[]
}

/** Enough of GitLab's REST API for the connector's host tools, in memory. */
export interface FakeGitlab {
	readonly url: string
	/** The user the token belongs to. */
	readonly self: string
	/** How many of the next requests answer 503, as GitLab does while it's down. */
	unavailableRequests: number
	/**
	 * Called for every request; when it returns a promise, the request waits until it settles. One
	 * that never settles is never answered, as when GitLab hangs.
	 */
	hold: (method: string, path: string) => Promise<void> | undefined
	/** The tokens that were sent in `Authorization` headers. */
	readonly tokens: Set<string>
	project(path: string, fields?: Partial<FakeProject>): FakeProject
	mergeRequest(project: string, iid: number, fields?: Partial<FakeMergeRequest>): FakeMergeRequest
	/** Adds a reviewer's note: a thread of its own, or a reply in thread `discussion`. */
	note(project: string, iid: number, body: string, options?: { discussion?: string; position?: FakeNote['position'] }): FakeNote
	/** Takes a note off the merge request, as a reviewer who deletes it. */
	deleteNote(project: string, iid: number, noteId: number): void
	/** Every note on a merge request, oldest first. */
	notes(project: string, iid: number): FakeNote[]
	/** The discussion a note is in. */
	discussionOf(project: string, iid: number, noteId: number): FakeDiscussion | undefined
	pipeline(project: string, fields: Partial<FakePipeline> & { sha: string }): FakePipeline
	close(): Promise<void>
}

const siteUrl = 'https://gitlab.example'

const now = () => new Date().toISOString()

const BodyField = z.object({ body: z.string() })
const AwardBody = z.object({ name: z.string() })
const MergeRequestBody = z.object({ source_branch: z.string(), target_branch: z.string(), title: z.string(), description: z.string() })
const MergeRequestUpdate = z.object({ title: z.string().optional(), description: z.string().optional() })

/** The items of `page`, `per_page` at a time, with GitLab's header for the next page. */
function paged<T>(context: Context, items: readonly T[]) {
	const perPage = Number(context.req.query('per_page') ?? '20')
	const page = Number(context.req.query('page') ?? '1')
	const start = (page - 1) * perPage
	const next = start + perPage < items.length ? String(page + 1) : ''
	return context.json(items.slice(start, start + perPage), 200, { 'x-next-page': next })
}

/** The project a route is under. */
function pathOf(context: Context): string {
	return context.req.param('project') ?? ''
}

/** The merge request's iid a route names. */
function iidOf(context: Context): number {
	return Number(context.req.param('iid'))
}

function notFound(context: Context) {
	return context.json({ message: '404 Not found' }, 404)
}

/** A merge request as the API answers with it: without the discussions, which have routes of their own. */
function mergeRequestJson(request: FakeMergeRequest) {
	const { discussions: _discussions, ...fields } = request
	return fields
}

export async function fakeGitlab(): Promise<FakeGitlab> {
	const projects = new Map<string, FakeProject>()
	const tokens = new Set<string>()
	const self = 'mesh-flow-bot'
	let nextId = 1000
	const id = () => ++nextId

	const project = (path: string, fields: Partial<FakeProject> = {}): FakeProject => {
		const known = projects.get(path)
		if (known !== undefined) return Object.assign(known, fields)
		const made: FakeProject = {
			path,
			name: path.split('/').at(-1) ?? path,
			description: '',
			mergeRequests: new Map(),
			pipelines: [],
			packages: [],
			...fields,
		}
		projects.set(path, made)
		return made
	}
	const mergeRequest = (path: string, iid: number, fields: Partial<FakeMergeRequest> = {}): FakeMergeRequest => {
		const known = project(path).mergeRequests.get(iid)
		if (known !== undefined) return Object.assign(known, fields)
		const made: FakeMergeRequest = {
			iid,
			title: `Merge request ${String(iid)}`,
			description: '',
			state: 'opened',
			web_url: `${siteUrl}/${path}/-/merge_requests/${String(iid)}`,
			source_branch: 'feature',
			target_branch: 'main',
			sha: '0'.repeat(40),
			merge_commit_sha: null,
			discussions: [],
			...fields,
		}
		project(path).mergeRequests.set(iid, made)
		return made
	}
	const newNote = (body: string, author: string, type: FakeNote['type'], position?: FakeNote['position']): FakeNote => ({
		id: id(),
		type,
		body,
		author: { username: author },
		created_at: now(),
		system: false,
		awards: [],
		...(position === undefined ? {} : { position }),
	})
	const newDiscussion = (notes: FakeNote[]): FakeDiscussion => ({ id: id().toString(16).padStart(40, 'a'), notes })
	const notes = (path: string, iid: number) =>
		mergeRequest(path, iid)
			.discussions.flatMap((discussion) => discussion.notes)
			.toSorted((one, other) => one.id - other.id)
	const discussionOf = (path: string, iid: number, noteId: number) =>
		mergeRequest(path, iid).discussions.find((discussion) => discussion.notes.some((note) => note.id === noteId))

	const settings: Pick<FakeGitlab, 'unavailableRequests' | 'hold'> = { unavailableRequests: 0, hold: () => undefined }
	const app = new Hono().basePath('/api/v4')
	app.use(async (context, next) => {
		const authorization = context.req.header('authorization')
		if (authorization === undefined) return context.json({ message: '401 Unauthorized' }, 401)
		tokens.add(authorization.replace(/^Bearer /, ''))
		await settings.hold(context.req.method, context.req.path)
		if (settings.unavailableRequests > 0) {
			settings.unavailableRequests--
			return context.json({ message: 'Service Unavailable' }, 503)
		}
		return next()
	})
	app.get('/user', (context) => context.json({ username: self }))
	app.get('/projects', (context) => {
		const search = (context.req.query('search') ?? '').toLowerCase()
		const found = [...projects.values()].filter(
			(listed) => listed.path.toLowerCase().includes(search) || listed.description.toLowerCase().includes(search),
		)
		return paged(
			context,
			found.map((listed) => ({
				path_with_namespace: listed.path,
				name: listed.name,
				description: listed.description,
				web_url: `${siteUrl}/${listed.path}`,
				default_branch: 'main',
			})),
		)
	})

	const inProject = new Hono()
	const known = (context: Context) => project(pathOf(context)).mergeRequests.get(iidOf(context))

	inProject.get('/merge_requests', (context) => {
		const state = context.req.query('state')
		const source = context.req.query('source_branch')
		const target = context.req.query('target_branch')
		const found = [...project(pathOf(context)).mergeRequests.values()].filter(
			(request) =>
				(state === undefined || request.state === state) &&
				(source === undefined || request.source_branch === source) &&
				(target === undefined || request.target_branch === target),
		)
		return paged(context, found.map(mergeRequestJson))
	})
	inProject.post('/merge_requests', async (context) => {
		const path = pathOf(context)
		const body = MergeRequestBody.parse(await context.req.json())
		const iid = project(path).mergeRequests.size + 1
		const made = mergeRequest(path, iid, {
			title: body.title,
			description: body.description,
			source_branch: body.source_branch,
			target_branch: body.target_branch,
			sha: shaOf(body.source_branch),
		})
		return context.json(mergeRequestJson(made), 201)
	})
	inProject.get('/merge_requests/:iid', (context) => {
		const request = known(context)
		return request === undefined ? notFound(context) : context.json(mergeRequestJson(request))
	})
	inProject.put('/merge_requests/:iid', async (context) => {
		const request = known(context)
		if (request === undefined) return notFound(context)
		const update = MergeRequestUpdate.parse(await context.req.json())
		if (update.title !== undefined) request.title = update.title
		if (update.description !== undefined) request.description = update.description
		return context.json(mergeRequestJson(request))
	})
	inProject.get('/merge_requests/:iid/discussions', (context) => {
		const request = known(context)
		if (request === undefined) return notFound(context)
		return paged(
			context,
			request.discussions.map((discussion) => ({
				id: discussion.id,
				notes: discussion.notes.map(({ awards: _awards, ...note }) => note),
			})),
		)
	})
	inProject.post('/merge_requests/:iid/discussions/:discussion/notes', async (context) => {
		const discussion = known(context)?.discussions.find((thread) => thread.id === context.req.param('discussion'))
		if (discussion === undefined) return notFound(context)
		const note = newNote(BodyField.parse(await context.req.json()).body, self, 'DiscussionNote')
		discussion.notes.push(note)
		return context.json(note, 201)
	})
	inProject.post('/merge_requests/:iid/notes', async (context) => {
		const request = known(context)
		if (request === undefined) return notFound(context)
		const note = newNote(BodyField.parse(await context.req.json()).body, self, null)
		request.discussions.push(newDiscussion([note]))
		return context.json(note, 201)
	})
	const noteOf = (context: Context) => {
		const noteId = Number(context.req.param('note'))
		return known(context)
			?.discussions.flatMap((discussion) => discussion.notes)
			.find((note) => note.id === noteId)
	}
	inProject.put('/merge_requests/:iid/notes/:note', async (context) => {
		const note = noteOf(context)
		if (note === undefined) return notFound(context)
		note.body = BodyField.parse(await context.req.json()).body
		return context.json(note)
	})
	inProject.get('/merge_requests/:iid/notes/:note/award_emoji', (context) => {
		const note = noteOf(context)
		return note === undefined ? notFound(context) : paged(context, note.awards)
	})
	inProject.post('/merge_requests/:iid/notes/:note/award_emoji', async (context) => {
		const note = noteOf(context)
		if (note === undefined) return notFound(context)
		const { name } = AwardBody.parse(await context.req.json())
		// GitLab takes one of each emoji per user.
		if (note.awards.some((award) => award.name === name && award.user.username === self))
			return context.json({ message: 'Award Emoji Name has already been taken' }, 404)
		const award: FakeAward = { id: id(), name, user: { username: self } }
		note.awards.push(award)
		return context.json(award, 201)
	})
	inProject.delete('/merge_requests/:iid/notes/:note/award_emoji/:award', (context) => {
		const note = noteOf(context)
		const wanted = Number(context.req.param('award'))
		if (note?.awards.some((award) => award.id === wanted) !== true) return notFound(context)
		note.awards = note.awards.filter((award) => award.id !== wanted)
		return context.body(null, 204)
	})
	inProject.get('/pipelines', (context) => {
		const sha = context.req.query('sha')
		const ref = context.req.query('ref')
		const found = project(pathOf(context))
			.pipelines.filter((pipeline) => (sha === undefined || pipeline.sha === sha) && (ref === undefined || pipeline.ref === ref))
			.toSorted((one, other) => other.id - one.id)
		return paged(
			context,
			found.map(({ jobs: _jobs, ...pipeline }) => pipeline),
		)
	})
	const pipelineOf = (context: Context) =>
		project(pathOf(context)).pipelines.find((pipeline) => pipeline.id === Number(context.req.param('pipeline')))
	inProject.get('/pipelines/:pipeline/jobs', (context) => {
		const pipeline = pipelineOf(context)
		if (pipeline === undefined) return notFound(context)
		const scope = context.req.query('scope[]')
		return paged(
			context,
			pipeline.jobs.filter((job) => scope === undefined || job.status === scope),
		)
	})
	inProject.get('/pipelines/:pipeline/bridges', (context) => (pipelineOf(context) === undefined ? notFound(context) : paged(context, [])))
	inProject.get('/packages', (context) => {
		const type = context.req.query('package_type')
		const found = project(pathOf(context)).packages.filter((listed) => type === undefined || listed.package_type === type)
		return paged(
			context,
			found.map((listed) => ({
				name: listed.name,
				version: listed.version,
				package_type: listed.package_type,
				pipeline: { id: listed.pipeline_id },
			})),
		)
	})
	app.route('/projects/:project', inProject)
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
		get hold() {
			return settings.hold
		},
		set hold(hold: FakeGitlab['hold']) {
			settings.hold = hold
		},
		tokens,
		project,
		mergeRequest,
		note(path, iid, body, options = {}) {
			const request = mergeRequest(path, iid)
			const thread = options.discussion === undefined ? undefined : request.discussions.find((listed) => listed.id === options.discussion)
			const note = newNote(body, 'reviewer', options.position === undefined ? null : 'DiffNote', options.position)
			if (thread === undefined) request.discussions.push(newDiscussion([note]))
			else thread.notes.push({ ...note, type: 'DiscussionNote' })
			return thread === undefined ? note : (thread.notes.at(-1) ?? note)
		},
		deleteNote(path, iid, noteId) {
			for (const discussion of mergeRequest(path, iid).discussions) discussion.notes = discussion.notes.filter((note) => note.id !== noteId)
		},
		notes,
		discussionOf,
		pipeline(path, fields) {
			const made: FakePipeline = {
				id: id(),
				ref: 'main',
				status: 'success',
				web_url: `${siteUrl}/${path}/-/pipelines/${String(nextId)}`,
				jobs: [],
				...fields,
			}
			project(path).pipelines.push(made)
			return made
		},
		close,
	}
}

/** A commit id for a branch name, the same every time. */
export function shaOf(branch: string): string {
	return Buffer.from(branch).toString('hex').padEnd(40, '0').slice(0, 40)
}
