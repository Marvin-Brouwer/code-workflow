import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt } from '@mesh-flow/core'
import { describe, expect, test } from 'vitest'
import { confluence, jira } from '../src/_module/atlassian.mts'
import { atlassianHostTools, defaultRequestRetry } from '../src/_module/host.mts'
import { keyedCommentProperty } from '../src/host/jira/jira-host-tools.mts'
import { fakeAtlassian, fakeIssue, type FakeIssue, type FakePage } from './support/fake-atlassian.mts'
import { runOnGateway, testGateway } from './support/test-run.mts'

const deployments = [
	{
		deployment: 'Cloud',
		settings: {
			'jira/url': 'https://example.atlassian.net',
			'jira/email': 'bot@example.com',
			'jira/token': 'cloud-token',
			'confluence/url': 'https://example.atlassian.net',
			'confluence/email': 'bot@example.com',
			'confluence/token': 'cloud-token',
		},
		jiraUrl: 'https://example.atlassian.net',
		jiraApi: '/rest/api/3',
		confluenceApi: '/wiki/rest/api',
		pageUrl: 'https://example.atlassian.net/wiki/spaces/TEAM/pages/12345',
		authorization: `Basic ${Buffer.from('bot@example.com:cloud-token').toString('base64')}`,
	},
	{
		deployment: 'Data Center',
		settings: {
			'jira/url': 'https://jira.example.com/',
			'jira/token': 'jira-pat',
			'confluence/url': 'https://wiki.example.com',
			'confluence/token': 'wiki-pat',
		},
		jiraUrl: 'https://jira.example.com',
		jiraApi: '/rest/api/2',
		confluenceApi: '/rest/api',
		pageUrl: 'https://wiki.example.com/spaces/TEAM/pages/12345',
		authorization: 'Bearer jira-pat',
	},
] as const
const [, dataCenter] = deployments

/** Retries as the connector's own, without the waits, so a test of a site in trouble takes no time. */
const quickRetry = { ...defaultRequestRetry, initialDelayMs: 1, backoffFactor: 1 }

/** What the fake holds before a run. */
interface Arrangement {
	readonly issues?: readonly FakeIssue[]
	readonly pages?: readonly FakePage[]
	readonly failNext?: readonly number[]
	readonly losesAnswers?: readonly string[]
	readonly latencyMs?: number
}

/** Runs `body` against a fake with the deployment's settings, and hands back what the fake saw. */
async function run<T>(settings: Readonly<Record<string, string>>, arrangement: Arrangement, body: () => Promise<T>) {
	const fake = fakeAtlassian()
	for (const issue of arrangement.issues ?? []) fake.issues.set(issue.key, issue)
	for (const page of arrangement.pages ?? []) fake.pages.set(page.id, page)
	fake.failNext.push(...(arrangement.failNext ?? []))
	for (const request of arrangement.losesAnswers ?? []) fake.losesAnswers.add(request)
	fake.latencyMs = arrangement.latencyMs ?? 0
	const gateway = await testGateway(atlassianHostTools({ fetch: fake.fetch, retry: quickRetry }), settings)
	const started = await runOnGateway(gateway, body)
	return { fake, started, result: await started.result }
}

describe.each(deployments)('on $deployment', ({ settings, jiraUrl, jiraApi, confluenceApi, pageUrl, authorization }) => {
	test('collect writes the issue as Markdown into the workspace and renders as its path', async () => {
		// Arrange
		const arrangement: Arrangement = {
			issues: [
				fakeIssue({
					key: 'PROJ-7',
					labels: ['web'],
					comments: [{ id: '1', author: 'Rita Reporter', created: '2026-11-10T10:00:00.000Z', html: '<p>Also on <em>iOS</em>.</p>' }],
					links: [
						{
							type: { inward: 'is blocked by', outward: 'blocks' },
							inwardIssue: { key: 'PROJ-3', fields: { summary: 'Session API', status: { name: 'Done' } } },
						},
					],
				}),
			],
		}

		// Act
		const { fake, started, result } = await run(settings, arrangement, async () => {
			const story = await jira.collect('PROJ-7')
			return { story, rendered: story[toPrompt](), markdown: await readFile(story[toPrompt](), 'utf8') }
		})

		// Assert
		expect(result.rendered).toBe(path.join(started.workspace, 'jira', 'PROJ-7.md'))
		expect(result.story.url).toBe(`${jiraUrl}/browse/PROJ-7`)
		expect(result.markdown).toContain('# PROJ-7: Login fails on Safari')
		expect(result.markdown).toContain('Steps: **open** the login page.')
		expect(result.markdown).toContain('- is blocked by PROJ-3: Session API (Done)')
		expect(result.markdown).toContain('### Rita Reporter, 2026-11-10T10:00:00.000Z\n\nAlso on _iOS_.')
		expect(fake.requests[0]).toMatchObject({ method: 'GET', path: `${jiraApi}/issue/PROJ-7`, authorization })
	})

	test('transition moves an issue once and does nothing when it already has the status', async () => {
		// Arrange
		const arrangement: Arrangement = { issues: [fakeIssue({ key: 'PROJ-7' })] }

		// Act
		const { fake, result } = await run(settings, arrangement, async () => [
			await jira.transition('PROJ-7', 'in progress'),
			await jira.transition({ key: 'PROJ-7' }, 'In Progress'),
		])

		// Assert
		expect(result).toEqual([{ moved: true }, { moved: false }])
		expect(fake.issues.get('PROJ-7')?.status).toBe('In Progress')
		expect(fake.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
	})

	test('transition names the statuses it can move to when none is the one asked for', async () => {
		// Arrange
		const arrangement: Arrangement = { issues: [fakeIssue({ key: 'PROJ-7' })] }

		// Act
		const outcome = run(settings, arrangement, () => jira.transition('PROJ-7', 'In Review'))

		// Assert
		await expect(outcome).rejects.toThrow("PROJ-7 can't move from To Do to In Review. It can move to: In Progress, Done.")
	})

	test('comment with a key updates its earlier comment', async () => {
		// Arrange
		const arrangement: Arrangement = { issues: [fakeIssue({ key: 'PROJ-7' })] }

		// Act
		const { fake, started, result } = await run(settings, arrangement, async () => {
			const first = await jira.comment('PROJ-7', 'Merge request: **one**', { key: 'mr-api' })
			const again = await jira.comment('PROJ-7', 'Merge request: **two**', { key: 'mr-api' })
			return { first, again }
		})

		// Assert
		expect(result.again.id).toBe(result.first.id)
		expect(result.first.url).toBe(`${jiraUrl}/browse/PROJ-7?focusedCommentId=${result.first.id}`)
		expect(fake.issues.get('PROJ-7')?.comments).toHaveLength(1)
		expect(fake.issues.get('PROJ-7')?.properties[keyedCommentProperty('mr-api')]).toEqual({ key: 'mr-api', id: result.first.id })
		const posted = JSON.stringify(fake.issues.get('PROJ-7')?.comments[0]?.posted)
		expect(posted).toContain('two')
		expect(posted).toContain(started.runId)
	})

	test('comment with a key posts again when a person deleted the earlier one', async () => {
		// Arrange
		const arrangement: Arrangement = {
			issues: [fakeIssue({ key: 'PROJ-7', properties: { [keyedCommentProperty('mr-api')]: { key: 'mr-api', id: '999' } } })],
		}

		// Act
		const { fake, result } = await run(settings, arrangement, () => jira.comment('PROJ-7', 'Merge request: three', { key: 'mr-api' }))

		// Assert
		expect(result.id).not.toBe('999')
		expect(fake.issues.get('PROJ-7')?.properties[keyedCommentProperty('mr-api')]).toEqual({ key: 'mr-api', id: result.id })
	})

	test('comments with different keys at once each keep their own id', async () => {
		// Arrange
		const arrangement: Arrangement = { issues: [fakeIssue({ key: 'PROJ-7' })], latencyMs: 20 }

		// Act
		const { fake, result } = await run(settings, arrangement, () =>
			Promise.all([jira.comment('PROJ-7', 'API', { key: 'mr-api' }), jira.comment('PROJ-7', 'Web', { key: 'mr-web' })]),
		)

		// Assert
		const [api, web] = result
		expect(fake.issues.get('PROJ-7')?.properties[keyedCommentProperty('mr-api')]).toEqual({ key: 'mr-api', id: api.id })
		expect(fake.issues.get('PROJ-7')?.properties[keyedCommentProperty('mr-web')]).toEqual({ key: 'mr-web', id: web.id })
	})

	test('comments with one key at once post one comment', async () => {
		// Arrange
		const arrangement: Arrangement = { issues: [fakeIssue({ key: 'PROJ-7' })], latencyMs: 20 }

		// Act
		const { fake, result } = await run(settings, arrangement, () =>
			Promise.all([jira.comment('PROJ-7', 'one', { key: 'status' }), jira.comment('PROJ-7', 'two', { key: 'status' })]),
		)

		// Assert
		expect(result[1].id).toBe(result[0].id)
		expect(fake.issues.get('PROJ-7')?.comments).toHaveLength(1)
	})

	test('a comment whose answer was lost is not posted again', async () => {
		// Arrange
		const fake = fakeAtlassian()
		fake.issues.set('PROJ-7', fakeIssue({ key: 'PROJ-7' }))
		fake.losesAnswers.add(`POST ${jiraApi}/issue/PROJ-7/comment`)
		const gateway = await testGateway(atlassianHostTools({ fetch: fake.fetch, retry: quickRetry }), settings)

		// Act
		const started = await runOnGateway(gateway, () => jira.comment('PROJ-7', 'Picked up'))

		// Assert
		await expect(started.result).rejects.toThrow()
		expect(fake.issues.get('PROJ-7')?.comments).toHaveLength(1)
	})

	test('a transition whose answer was lost counts as made', async () => {
		// Arrange
		const arrangement: Arrangement = { issues: [fakeIssue({ key: 'PROJ-7' })], losesAnswers: [`POST ${jiraApi}/issue/PROJ-7/transitions`] }

		// Act
		const { fake, result } = await run(settings, arrangement, () => jira.transition('PROJ-7', 'In Progress'))

		// Assert
		expect(result).toEqual({ moved: true })
		expect(fake.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/transitions'))).toHaveLength(1)
	})

	test('search finds issues by JQL and says whether there are more', async () => {
		// Arrange
		const arrangement: Arrangement = { issues: [fakeIssue({ key: 'PROJ-7' })] }

		// Act
		const { result } = await run(settings, arrangement, () => jira.search({ jql: 'project = PROJ', limit: 5 }))

		// Assert
		expect(result).toEqual({
			issues: [
				{
					key: 'PROJ-7',
					summary: 'Login fails on Safari',
					status: 'To Do',
					type: 'Story',
					url: `${jiraUrl}/browse/PROJ-7`,
				},
			],
			more: false,
		})
	})

	test('confluence collect reads a page by its URL and search strips the highlights', async () => {
		// Arrange
		const arrangement: Arrangement = {
			pages: [{ id: '12345', title: 'Guidelines', space: 'TEAM', html: '<h2>Commits</h2><p>Use conventional commits.</p>', version: 4 }],
		}

		// Act
		const { fake, result } = await run(settings, arrangement, async () => {
			const page = await confluence.collect(`${pageUrl}/Guidelines`)
			return { page, markdown: await readFile(page[toPrompt](), 'utf8'), found: await confluence.search({ text: 'conventional' }) }
		})

		// Assert
		expect(result.page.url).toBe(pageUrl)
		expect(result.markdown).toContain('## Commits\n\nUse conventional commits.')
		expect(result.found.pages).toEqual([
			{ id: '12345', title: 'Guidelines', space: 'TEAM', url: pageUrl, excerpt: 'conventional and more' },
		])
		expect(fake.requests[0]?.path).toBe(`${confluenceApi}/content/12345`)
	})
})

describe('settings', () => {
	test('a missing site says how to set it', async () => {
		// Act
		const outcome = run({ 'jira/token': 'token' }, {}, () => jira.collect('PROJ-7'))

		// Assert
		await expect(outcome).rejects.toThrow('There is no jira site. Set it with `mesh-flow credential set jira/url`.')
	})
})

describe('stopping', () => {
	test('stopping the run settles a call to a site that never answers', async () => {
		// Arrange
		const fake = fakeAtlassian()
		fake.hanging.add('/rest/api/2/issue/PROJ-7')
		const gateway = await testGateway(atlassianHostTools({ fetch: fake.fetch }), dataCenter.settings)
		const started = await runOnGateway(gateway, () => jira.collect('PROJ-7'))
		await expect.poll(() => fake.requests.length).toBe(1)

		// Act
		started.controller.abort(new Error('Stopped.'))

		// Assert
		await expect(started.outcome).resolves.toBeDefined()
		await expect(started.result).rejects.toThrow()
		await expect.poll(() => fake.requests[0]?.signal?.aborted).toBe(true)
	})
})

describe('Confluence sites', () => {
	test.each([
		{
			site: 'a Cloud site given with /wiki',
			settings: { 'confluence/url': 'https://example.atlassian.net/wiki', 'confluence/email': 'bot@example.com' },
			path: '/wiki/rest/api/content/12345',
		},
		{
			site: 'a Data Center site under a context path',
			settings: { 'confluence/url': 'https://example.com/confluence/' },
			path: '/confluence/rest/api/content/12345',
		},
	])('$site keeps its path once', async ({ settings, path: expected }) => {
		// Arrange
		const arrangement: Arrangement = { pages: [{ id: '12345', title: 'Guidelines', space: 'TEAM', html: '<p>Hi</p>', version: 1 }] }

		// Act
		const { fake } = await run({ ...settings, 'confluence/token': 'token' }, arrangement, () => confluence.collect('12345'))

		// Assert
		expect(fake.requests[0]?.path).toBe(expected)
	})
})

describe('trouble', () => {
	test('a 503 is sent again by the client before the call fails', async () => {
		// Arrange
		const arrangement: Arrangement = { issues: [fakeIssue({ key: 'PROJ-7' })], failNext: [503] }

		// Act
		const { fake, result } = await run(dataCenter.settings, arrangement, () => jira.collect('PROJ-7'))

		// Assert
		expect(result.key).toBe('PROJ-7')
		expect(fake.requests).toHaveLength(2)
	})
})
