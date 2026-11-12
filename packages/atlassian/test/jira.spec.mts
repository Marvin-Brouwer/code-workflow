import { readFile } from 'node:fs/promises'
import { toPrompt } from '@mesh-flow/core'
import { describe, expect, test } from 'vitest'
import { confluence, jira } from '../src/_module/atlassian.mts'
import { atlassianHostTools } from '../src/_module/host.mts'
import { keyedCommentsProperty } from '../src/host/jira/jira-host-tools.mts'
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
		jiraApi: '/rest/api/2',
		confluenceApi: '/rest/api',
		pageUrl: 'https://wiki.example.com/spaces/TEAM/pages/12345',
		authorization: 'Bearer jira-pat',
	},
] as const

/** What the fake holds before a run. */
interface Arrangement {
	readonly issues?: readonly FakeIssue[]
	readonly pages?: readonly FakePage[]
	readonly failNext?: readonly number[]
}

/** Runs `body` against a fake with the deployment's settings, and hands back what the fake saw. */
async function run<T>(settings: Readonly<Record<string, string>>, arrangement: Arrangement, body: () => Promise<T>) {
	const fake = fakeAtlassian()
	for (const issue of arrangement.issues ?? []) fake.issues.set(issue.key, issue)
	for (const page of arrangement.pages ?? []) fake.pages.set(page.id, page)
	fake.failNext.push(...(arrangement.failNext ?? []))
	const gateway = await testGateway(atlassianHostTools({ fetch: fake.fetch }), settings)
	const started = await runOnGateway(gateway, body)
	return { fake, started, result: await started.result }
}

describe.each(deployments)('on $deployment', ({ settings, jiraApi, confluenceApi, pageUrl, authorization }) => {
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
		expect(result.rendered).toBe(`${started.workspace}/jira/PROJ-7.md`)
		expect(result.story.url).toBe(`${settings['jira/url'].replace(/\/$/, '')}/browse/PROJ-7`)
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
		expect(result.first.url).toBe(`${settings['jira/url'].replace(/\/$/, '')}/browse/PROJ-7?focusedCommentId=${result.first.id}`)
		expect(fake.issues.get('PROJ-7')?.comments).toHaveLength(1)
		expect(fake.issues.get('PROJ-7')?.properties[keyedCommentsProperty]).toEqual({ 'mr-api': result.first.id })
		const posted = JSON.stringify(fake.issues.get('PROJ-7')?.comments[0]?.posted)
		expect(posted).toContain('two')
		expect(posted).toContain(started.runId)
	})

	test('comment with a key posts again when a person deleted the earlier one', async () => {
		// Arrange
		const arrangement: Arrangement = {
			issues: [fakeIssue({ key: 'PROJ-7', properties: { [keyedCommentsProperty]: { 'mr-api': '999', other: '5' } } })],
		}

		// Act
		const { fake, result } = await run(settings, arrangement, () => jira.comment('PROJ-7', 'Merge request: three', { key: 'mr-api' }))

		// Assert
		expect(result.id).not.toBe('999')
		expect(fake.issues.get('PROJ-7')?.properties[keyedCommentsProperty]).toEqual({ 'mr-api': result.id, other: '5' })
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
					url: `${settings['jira/url'].replace(/\/$/, '')}/browse/PROJ-7`,
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
		const gateway = await testGateway(atlassianHostTools({ fetch: fake.fetch }), deployments[1].settings)
		const started = await runOnGateway(gateway, () => jira.collect('PROJ-7'))
		await expect.poll(() => fake.requests.length).toBe(1)

		// Act
		started.controller.abort(new Error('Stopped.'))

		// Assert
		await expect(started.outcome).resolves.toBeDefined()
		await expect(started.result).rejects.toThrow()
	})
})

describe('trouble', () => {
	test('a 503 is sent again by the client before the call fails', async () => {
		// Arrange
		const arrangement: Arrangement = { issues: [fakeIssue({ key: 'PROJ-7' })], failNext: [503] }

		// Act
		const { fake, result } = await run(deployments[1].settings, arrangement, () => jira.collect('PROJ-7'))

		// Assert
		expect(result.key).toBe('PROJ-7')
		expect(fake.requests).toHaveLength(2)
	})
})
