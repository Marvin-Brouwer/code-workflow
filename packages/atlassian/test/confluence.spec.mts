import { readFile } from 'node:fs/promises'
import { toPrompt } from '@mesh-flow/core'
import { expect, test } from 'vitest'
import { confluence } from '../src/_module/atlassian.mts'
import { run, type Arrangement } from './support/run-on-fake.mts'

const settings = {
	'confluence/url': 'https://example.atlassian.net',
	'confluence/email': 'bot@example.com',
	'confluence/token': 'cloud-token',
}

const mention = '<a href="/secure/ViewProfile.jspa?accountId=5b10" class="user-hover" data-account-id="5b10">@Rita Reporter</a>'

const html = [
	`<p>Owner: ${mention}</p>`,
	'<h2>Commits</h2>',
	'<p>Use <a href="https://www.conventionalcommits.org">conventional commits</a>, for example:</p>',
	'<pre><code>fix(login): keep the session on Safari</code></pre>',
	'<h2>Reviews</h2>',
	'<ul><li>One approval from the <strong>owning team</strong>.</li><li>Green checks, <em>including</em> the end-to-end run.</li></ul>',
	'<table><tr><th>Change</th><th>Reviewers</th></tr><tr><td>Code</td><td>1</td></tr><tr><td>Infrastructure</td><td>2</td></tr></table>',
].join('')

/** One page with most of what Confluence can hold, so the whole Markdown it's written as can be read in `confluence.spec.md`. */
const arrangement: Arrangement = {
	pages: [{ id: '12345', title: 'Guidelines', space: 'TEAM', html, version: 4 }],
	users: { '5b10': { displayName: 'Rita Reporter', email: 'rita@example.com' } },
}

test('collect writes a page as the Markdown in confluence.spec.md', async () => {
	// Act
	const { result } = await run(settings, arrangement, async () => readFile((await confluence.collect('12345'))[toPrompt](), 'utf8'))

	// Assert
	await expect(result).toMatchFileSnapshot('./confluence.spec.md')
})
