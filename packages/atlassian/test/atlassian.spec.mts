import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt } from '@mesh-flow/core'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { confluence, jira } from '../src/_module/atlassian.mts'
import { atlassianHostTools, defaultRequestRetry } from '../src/_module/host.mts'
import { maxImageBytes, maxImageBytesPerIssue } from '../src/host/jira/attachments.mts'
import { keyedCommentProperty } from '../src/host/jira/jira-host-tools.mts'
import {
	fakeAtlassian,
	fakeIssue,
	type FakeAtlassian,
	type FakeIssue,
	type FakePage,
	type FakeRequest,
	type FakeUser,
} from './support/fake-atlassian.mts'
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
		mention: (name: string) => `<a href="/secure/ViewProfile.jspa?accountId=5b10" class="user-hover" data-account-id="5b10">@${name}</a>`,
		mentionId: '5b10',
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
		mention: (name: string) => `<a href="/secure/ViewProfile.jspa?name=rita" class="user-hover" rel="rita">${name}</a>`,
		mentionId: 'rita',
	},
] as const
const [, dataCenter] = deployments

/** The first bytes of a PNG file: enough of an image for the fake to serve. */
const pngSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

/** Whether a request read an attachment's bytes. */
const isAttachmentRequest = (request: FakeRequest) => request.path.startsWith('/secure/attachment/')

/** Collects an issue and reads back its Markdown. */
async function collectMarkdown(key: string) {
	const story = await jira.collect(key)
	return { story, markdown: await readFile(story[toPrompt](), 'utf8') }
}

/** Retries as the connector's own, without the waits, so a test of a site in trouble takes no time. */
const quickRetry = { ...defaultRequestRetry, initialDelayMs: 1, backoffFactor: 1 }

/** The YAML between the `---` lines a written issue or page starts with. */
function frontmatterOf(markdown: string): unknown {
	const [, yaml] = /^---\n([\s\S]*?)\n---\n/.exec(markdown) ?? []
	if (yaml === undefined) throw new Error('The Markdown has no frontmatter.')
	return parse(yaml)
}

/** What the fake holds before a run. */
interface Arrangement {
	readonly issues?: readonly FakeIssue[]
	readonly pages?: readonly FakePage[]
	readonly failNext?: readonly number[]
	readonly losesAnswers?: readonly string[]
	readonly latencyMs?: number
	readonly users?: Readonly<Record<string, FakeUser>>
}

/** Runs `body` against a fake with the deployment's settings, and hands back what the fake saw. */
async function run<T>(settings: Readonly<Record<string, string>>, arrangement: Arrangement, body: () => Promise<T>) {
	const fake = fakeAtlassian()
	for (const issue of arrangement.issues ?? []) fake.issues.set(issue.key, issue)
	for (const page of arrangement.pages ?? []) fake.pages.set(page.id, page)
	fake.failNext.push(...(arrangement.failNext ?? []))
	for (const request of arrangement.losesAnswers ?? []) fake.losesAnswers.add(request)
	fake.latencyMs = arrangement.latencyMs ?? 0
	for (const [id, user] of Object.entries(arrangement.users ?? {})) fake.users.set(id, user)
	const gateway = await testGateway(atlassianHostTools({ fetch: fake.fetch, retry: quickRetry }), settings)
	const started = await runOnGateway(gateway, body)
	return { fake, started, result: await started.result }
}

describe.each(deployments)(
	'on $deployment',
	({ settings, jiraUrl, jiraApi, confluenceApi, pageUrl, authorization, mention, mentionId }) => {
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
			expect(frontmatterOf(result.markdown)).toMatchObject({
				key: 'PROJ-7',
				summary: 'Login fails on Safari',
				url: `${jiraUrl}/browse/PROJ-7`,
				labels: ['web'],
				links: [{ relation: 'is blocked by', key: 'PROJ-3', summary: 'Session API', status: 'Done' }],
			})
			expect(result.markdown).toContain('# PROJ-7: Login fails on Safari')
			expect(result.markdown).toContain('Steps: **open** the login page.')
			expect(result.markdown).toContain('### Rita Reporter, 2026-11-10T10:00:00.000Z\n\nAlso on _iOS_.')
			expect(fake.requests[0]).toMatchObject({ method: 'GET', path: `${jiraApi}/issue/PROJ-7`, authorization })
		})

		test("collect brings an issue's images next to its Markdown, links to them, and lists every attachment", async () => {
			// Arrange
			const arrangement: Arrangement = {
				issues: [
					fakeIssue({
						key: 'PROJ-7',
						descriptionHtml: '<p>See <img src="/secure/attachment/10001/login%20page.png" alt="login page"></p>',
						comments: [
							{
								id: '1',
								author: 'Rita Reporter',
								created: '2026-11-10T10:00:00.000Z',
								html: '<p><img src="/secure/thumbnail/10001/login%20page.png"></p>',
							},
						],
						attachments: [
							{ id: '10001', filename: 'login page.png', mimeType: 'image/png', bytes: pngSignature },
							{ id: '10002', filename: 'trace.har', mimeType: 'application/json', bytes: new Uint8Array([0x7b, 0x7d]) },
						],
					}),
				],
			}

			// Act
			const { fake, started, result } = await run(settings, arrangement, () => collectMarkdown('PROJ-7'))

			// Assert
			const image = path.join(started.workspace, 'jira', 'PROJ-7', '10001-login_page.png')
			expect(new Uint8Array(await readFile(image))).toEqual(pngSignature)
			expect(result.markdown).toContain('See ![login page](PROJ-7/10001-login_page.png)')
			expect(result.markdown).toContain('![](PROJ-7/10001-login_page.png)')
			expect(frontmatterOf(result.markdown)).toMatchObject({
				attachments: [
					{ filename: 'login page.png', mimeType: 'image/png', file: 'PROJ-7/10001-login_page.png' },
					{ filename: 'trace.har', mimeType: 'application/json', url: `${jiraUrl}/secure/attachment/10002/trace.har` },
				],
			})
			expect(result.story.attachments.map((attachment) => attachment.data)).toEqual([undefined, undefined])
			expect(fake.requests.filter(isAttachmentRequest)).toMatchObject([
				{ path: '/secure/attachment/10001/login%20page.png', authorization },
			])
		})

		test('collect leaves an image too large, or on another host, as a link, and never sends the token elsewhere', async () => {
			// Arrange
			const arrangement: Arrangement = {
				issues: [
					fakeIssue({
						key: 'PROJ-7',
						descriptionHtml: '<p><img src="/secure/attachment/10003/huge.png" alt="huge"></p>',
						attachments: [
							{ id: '10003', filename: 'huge.png', mimeType: 'image/png', bytes: new Uint8Array(maxImageBytes + 1) },
							{
								id: '10004',
								filename: 'elsewhere.png',
								mimeType: 'image/png',
								bytes: new Uint8Array(1),
								content: 'https://files.example.org/secure/attachment/10004/elsewhere.png',
							},
						],
					}),
				],
			}

			// Act
			const { fake, result } = await run(settings, arrangement, () => collectMarkdown('PROJ-7'))

			// Assert
			expect(result.markdown).toContain(`![huge](${jiraUrl}/secure/attachment/10003/huge.png)`)
			expect(frontmatterOf(result.markdown)).toMatchObject({
				attachments: [
					{ url: `${jiraUrl}/secure/attachment/10003/huge.png` },
					{ url: 'https://files.example.org/secure/attachment/10004/elsewhere.png' },
				],
			})
			expect(fake.requests.filter(isAttachmentRequest)).toEqual([])
		})

		test('collect names a mentioned person by name, the email the site shows and their id', async () => {
			// Arrange
			const arrangement: Arrangement = {
				issues: [
					fakeIssue({
						key: 'PROJ-7',
						descriptionHtml: `<p>Ask ${mention('Rita Reporter')}.</p>`,
						comments: [
							{ id: '1', author: 'Rita Reporter', created: '2026-11-10T10:00:00.000Z', html: `<p>${mention('Rita Reporter')} knows.</p>` },
						],
					}),
				],
				users: { [mentionId]: { displayName: 'Rita Reporter', email: 'rita@example.com' } },
			}

			// Act
			const { fake, result } = await run(settings, arrangement, () => collectMarkdown('PROJ-7'))

			// Assert
			const rita = `\`@mention({ name: "Rita Reporter", email: "rita@example.com", id: "${mentionId}" })\``
			expect(result.markdown).toContain(`Ask ${rita}.`)
			expect(result.markdown).toContain(`${rita} knows.`)
			expect(fake.requests.filter((request) => request.path === `${jiraApi}/user`)).toHaveLength(1)
		})

		test('collect leaves out the email of a person the site keeps it private for', async () => {
			// Arrange
			const arrangement: Arrangement = {
				issues: [fakeIssue({ key: 'PROJ-7', descriptionHtml: `<p>Ask ${mention('Rita Reporter')}.</p>` })],
				users: { [mentionId]: { displayName: 'Rita Reporter' } },
			}

			// Act
			const { result } = await run(settings, arrangement, () => collectMarkdown('PROJ-7'))

			// Assert
			expect(result.markdown).toContain(`Ask \`@mention({ name: "Rita Reporter", id: "${mentionId}" })\`.`)
		})

		test("collect keeps the name and id a mention links to when the site doesn't know the person", async () => {
			// Arrange
			const arrangement: Arrangement = {
				issues: [fakeIssue({ key: 'PROJ-7', descriptionHtml: `<p>Ask ${mention('Rita Reporter')}.</p>` })],
			}

			// Act
			const { result } = await run(settings, arrangement, () => collectMarkdown('PROJ-7'))

			// Assert
			expect(result.markdown).toContain(`Ask \`@mention({ name: "Rita Reporter", id: "${mentionId}" })\`.`)
		})

		test('collect points the images and mentions in a table where the rest of the text has them', async () => {
			// Arrange
			const arrangement: Arrangement = {
				issues: [
					fakeIssue({
						key: 'PROJ-7',
						descriptionHtml: `<table><tr><td><img src="/secure/attachment/10001/shot.png"></td><td>${mention('Rita Reporter')}</td></tr></table>`,
						attachments: [{ id: '10001', filename: 'shot.png', mimeType: 'image/png', bytes: pngSignature }],
					}),
				],
				users: { [mentionId]: { displayName: 'Rita Reporter' } },
			}

			// Act
			const { result } = await run(settings, arrangement, () => collectMarkdown('PROJ-7'))

			// Assert
			expect(result.markdown).toContain('<img src="PROJ-7/10001-shot.png">')
			expect(result.markdown).toContain(`<td>\`@mention({ name: "Rita Reporter", id: "${mentionId}" })\`</td>`)
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
			// On Data Center the run id is in a code span, where wiki markup's `-` is escaped.
			expect(posted.replaceAll('\\\\-', '-')).toContain(started.runId)
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
			const arrangement: Arrangement = {
				issues: [fakeIssue({ key: 'PROJ-7' })],
				losesAnswers: [`POST ${jiraApi}/issue/PROJ-7/transitions`],
			}

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

		test('confluence collect names a mentioned person by name, the email the site shows and their id', async () => {
			// Arrange
			const arrangement: Arrangement = {
				pages: [{ id: '12345', title: 'Guidelines', space: 'TEAM', html: `<p>Owner: ${mention('Rita Reporter')}</p>`, version: 4 }],
				users: { [mentionId]: { displayName: 'Rita Reporter', email: 'rita@example.com' } },
			}

			// Act
			const { result } = await run(settings, arrangement, async () => {
				const page = await confluence.collect('12345')
				return { markdown: await readFile(page[toPrompt](), 'utf8') }
			})

			// Assert
			expect(result.markdown).toContain(`Owner: \`@mention({ name: "Rita Reporter", email: "rita@example.com", id: "${mentionId}" })\``)
		})

		test("confluence collect keeps the id a mention links to when the site doesn't know the person", async () => {
			// Arrange
			const arrangement: Arrangement = {
				pages: [{ id: '12345', title: 'Guidelines', space: 'TEAM', html: `<p>Owner: ${mention('Rita Reporter')}</p>`, version: 4 }],
			}

			// Act
			const { result } = await run(settings, arrangement, async () => {
				const page = await confluence.collect('12345')
				return { markdown: await readFile(page[toPrompt](), 'utf8') }
			})

			// Assert
			expect(result.markdown).toContain(`Owner: \`@mention({ name: "Rita Reporter", id: "${mentionId}" })\``)
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
			expect(frontmatterOf(result.markdown)).toMatchObject({
				id: '12345',
				title: 'Guidelines',
				url: pageUrl,
				space: 'TEAM',
				version: 4,
			})
			expect(result.markdown).toContain('## Commits\n\nUse conventional commits.')
			expect(result.found.pages).toEqual([
				{ id: '12345', title: 'Guidelines', space: 'TEAM', url: pageUrl, excerpt: 'conventional and more' },
			])
			expect(fake.requests[0]?.path).toBe(`${confluenceApi}/content/12345`)
		})
	},
)

describe('attachments', () => {
	test('an issue brings images up to its limit in all, and links to the rest', async () => {
		// Arrange
		const imageBytes = maxImageBytes - 1
		const fit = Math.floor(maxImageBytesPerIssue / imageBytes)
		const attachments = Array.from({ length: fit + 1 }, (_, index) => ({
			id: String(10001 + index),
			filename: `shot-${index}.png`,
			mimeType: 'image/png',
			bytes: new Uint8Array(imageBytes),
		}))
		const arrangement: Arrangement = { issues: [fakeIssue({ key: 'PROJ-7', attachments })] }

		// Act
		const { result } = await run(dataCenter.settings, arrangement, () => collectMarkdown('PROJ-7'))

		// Assert
		expect(result.story.attachments.filter((attachment) => attachment.file !== undefined)).toHaveLength(fit)
		expect(result.story.attachments.at(-1)).toMatchObject({ url: `${dataCenter.jiraUrl}/secure/attachment/${10001 + fit}/shot-${fit}.png` })
	})

	test('a link around an image points at its copy, one on the site is made absolute, and one in the text stays', async () => {
		// Arrange
		const descriptionHtml =
			'<p><a href="/secure/attachment/10001/shot.png"><img src="/secure/thumbnail/10001/shot.png"></a> <a href="/browse/PROJ-8">PROJ-8</a> <a href="#steps">steps</a> <a href="/wiki/Foo)">foo</a></p>'
		const arrangement: Arrangement = {
			issues: [
				fakeIssue({
					key: 'PROJ-7',
					descriptionHtml,
					attachments: [
						{ id: '10001', filename: 'shot.png', mimeType: 'image/png', bytes: pngSignature, servedAs: 'application/octet-stream' },
					],
				}),
			],
		}

		// Act
		const { result } = await run(dataCenter.settings, arrangement, () => collectMarkdown('PROJ-7'))

		// Assert
		expect(result.markdown).toContain(
			`[![](PROJ-7/10001-shot.png)](PROJ-7/10001-shot.png) [PROJ-8](${dataCenter.jiraUrl}/browse/PROJ-8) [steps](#steps) [foo](${dataCenter.jiraUrl}/wiki/Foo\\))`,
		)
	})

	test("an attachment whose id isn't one stays a link and is never written", async () => {
		// Arrange
		const arrangement: Arrangement = {
			issues: [
				fakeIssue({ key: 'PROJ-7', attachments: [{ id: '../x', filename: 'shot.png', mimeType: 'image/png', bytes: pngSignature }] }),
			],
		}

		// Act
		const { fake, result } = await run(dataCenter.settings, arrangement, () => collectMarkdown('PROJ-7'))

		// Assert
		expect(result.story.attachments).toEqual([
			{ id: '../x', filename: 'shot.png', mimeType: 'image/png', url: `${dataCenter.jiraUrl}/secure/x/shot.png` },
		])
		expect(fake.requests.filter(isAttachmentRequest)).toEqual([])
	})

	test.each([
		{ answer: 'a 404', attachment: { status: 404 } },
		{ answer: 'a 500', attachment: { status: 500 } },
		{ answer: 'a sign-in page', attachment: { servedAs: 'text/html' } },
		{ answer: 'a larger file than it said', attachment: { size: 1, bytes: new Uint8Array(maxImageBytes + 1) } },
		{ answer: 'a file without a size, too large', attachment: { size: undefined, bytes: new Uint8Array(maxImageBytes + 1) } },
	])('an image the site answers with $answer stays a link', async ({ attachment }) => {
		// Arrange
		const arrangement: Arrangement = {
			issues: [
				fakeIssue({
					key: 'PROJ-7',
					descriptionHtml: '<p><img src="/secure/attachment/10001/shot.png"></p>',
					attachments: [{ id: '10001', filename: 'shot.png', mimeType: 'image/png', bytes: pngSignature, ...attachment }],
				}),
			],
		}

		// Act
		const { fake, result } = await run(dataCenter.settings, arrangement, () => collectMarkdown('PROJ-7'))

		// Assert
		expect(result.markdown).toContain(`![](${dataCenter.jiraUrl}/secure/attachment/10001/shot.png)`)
		expect(result.story.attachments).toMatchObject([{ url: `${dataCenter.jiraUrl}/secure/attachment/10001/shot.png` }])
		expect(fake.requests.filter(isAttachmentRequest)).toHaveLength(1)
	})
})

describe('settings', () => {
	test('a missing site says how to set it', async () => {
		// Act
		const outcome = run({ 'jira/token': 'token' }, {}, () => jira.collect('PROJ-7'))

		// Assert
		await expect(outcome).rejects.toThrow('There is no Jira site. Set it with `mesh-flow credential set jira/url`.')
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

	test('stopping the run settles a collect whose image never arrives', async () => {
		// Arrange
		const fake = fakeAtlassian()
		fake.issues.set(
			'PROJ-7',
			fakeIssue({ key: 'PROJ-7', attachments: [{ id: '10001', filename: 'shot.png', mimeType: 'image/png', bytes: new Uint8Array(1) }] }),
		)
		fake.hanging.add('/secure/attachment/10001/shot.png')
		const gateway = await testGateway(atlassianHostTools({ fetch: fake.fetch }), dataCenter.settings)
		const started = await runOnGateway(gateway, () => jira.collect('PROJ-7'))
		await expect.poll(() => fake.requests.length).toBe(2)

		// Act
		started.controller.abort(new Error('Stopped.'))

		// Assert
		await expect(started.outcome).resolves.toBeDefined()
		await expect(started.result).rejects.toThrow()
		await expect.poll(() => fake.requests[1]?.signal?.aborted).toBe(true)
	})

	test.each([
		{
			product: 'jira',
			path: '/rest/api/2/user',
			arrange: (fake: FakeAtlassian) =>
				fake.issues.set('PROJ-7', fakeIssue({ key: 'PROJ-7', descriptionHtml: `<p>${dataCenter.mention('Rita')}</p>` })),
			collect: async (): Promise<unknown> => jira.collect('PROJ-7'),
		},
		{
			product: 'confluence',
			path: '/rest/api/user',
			arrange: (fake: FakeAtlassian) =>
				fake.pages.set('12345', {
					id: '12345',
					title: 'Guidelines',
					space: 'TEAM',
					html: `<p>${dataCenter.mention('Rita')}</p>`,
					version: 1,
				}),
			collect: async (): Promise<unknown> => confluence.collect('12345'),
		},
	])('stopping the run settles a $product collect whose mention is never looked up', async ({ path: userPath, arrange, collect }) => {
		// Arrange
		const fake = fakeAtlassian()
		arrange(fake)
		fake.hanging.add(userPath)
		const gateway = await testGateway(atlassianHostTools({ fetch: fake.fetch }), dataCenter.settings)
		const started = await runOnGateway(gateway, collect)
		await expect.poll(() => fake.requests.length).toBe(2)

		// Act
		started.controller.abort(new Error('Stopped.'))

		// Assert
		await expect(started.outcome).resolves.toBeDefined()
		await expect(started.result).rejects.toThrow()
		await expect.poll(() => fake.requests[1]?.signal?.aborted).toBe(true)
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

test('a Data Center page names a mentioned person by their username', async () => {
	// Arrange
	const html = '<p>Owner: <a class="confluence-userlink" data-username="rita" href="/display/~rita">Rita Reporter</a></p>'
	const arrangement: Arrangement = {
		pages: [{ id: '12345', title: 'Guidelines', space: 'TEAM', html, version: 1 }],
		users: { rita: { displayName: 'Rita Reporter', email: 'rita@example.com' } },
	}

	// Act
	const { fake, result } = await run(dataCenter.settings, arrangement, async () =>
		readFile((await confluence.collect('12345'))[toPrompt](), 'utf8'),
	)

	// Assert
	expect(result).toContain('Owner: `@mention({ name: "Rita Reporter", email: "rita@example.com", id: "rita" })`')
	expect(fake.requests.find((request) => request.path === '/rest/api/user')?.query.get('username')).toBe('rita')
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
