import { readFile } from 'node:fs/promises'
import { toPrompt } from '@mesh-flow/core'
import { expect, test } from 'vitest'
import { jira } from '../src/_module/atlassian.mts'
import { fakeIssue } from './support/fake-atlassian.mts'
import { run, type Arrangement } from './support/run-on-fake.mts'

const settings = {
	'jira/url': 'https://example.atlassian.net',
	'jira/email': 'bot@example.com',
	'jira/token': 'cloud-token',
}

const mention = '<a href="/secure/ViewProfile.jspa?accountId=5b10" class="user-hover" data-account-id="5b10">@Rita Reporter</a>'

const descriptionHtml = [
	'<h2>Steps</h2>',
	'<ol><li>Open the <strong>login</strong> page in Safari.</li><li>Sign in with <code>user@example.com</code>.</li></ol>',
	'<p>See <img src="/secure/attachment/10001/login%20page.png" alt="login page"></p>',
	'<h2>Expected</h2>',
	'<p>The dashboard opens, as described in <a href="https://example.atlassian.net/wiki/spaces/TEAM/pages/12345">the guidelines</a>.</p>',
	'<pre><code>POST /session 200</code></pre>',
	'<table><tr><th>Browser</th><th>Result</th></tr><tr><td>Safari 19</td><td>fails</td></tr><tr><td>Firefox</td><td>works</td></tr></table>',
	`<p>Ask ${mention} for a test account.</p>`,
].join('')

/** One issue with most of what Jira can hold, so the whole Markdown it's written as can be read in `jira.spec.md`. */
const arrangement: Arrangement = {
	issues: [
		fakeIssue({
			key: 'PROJ-7',
			labels: ['web', 'safari'],
			descriptionHtml,
			comments: [
				{ id: '1', author: 'Rita Reporter', created: '2026-11-10T10:00:00.000Z', html: '<p>Also on <em>iOS</em>.</p>' },
				{ id: '2', author: 'Dev Eloper', created: '2026-11-11T08:30:00.000Z', html: `<p>${mention} can you share the HAR file?</p>` },
			],
			links: [
				{
					type: { inward: 'is blocked by', outward: 'blocks' },
					inwardIssue: { key: 'PROJ-3', fields: { summary: 'Session API', status: { name: 'Done' } } },
				},
			],
			attachments: [
				{ id: '10001', filename: 'login page.png', mimeType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
				{ id: '10002', filename: 'trace.har', mimeType: 'application/json', bytes: new Uint8Array([0x7b, 0x7d]) },
			],
		}),
	],
	users: { '5b10': { displayName: 'Rita Reporter', email: 'rita@example.com' } },
}

test('collect writes an issue as the Markdown in jira.spec.md', async () => {
	// Act
	const { result } = await run(settings, arrangement, async () => readFile((await jira.collect('PROJ-7'))[toPrompt](), 'utf8'))

	// Assert
	await expect(result).toMatchFileSnapshot('./jira.spec.md')
})
