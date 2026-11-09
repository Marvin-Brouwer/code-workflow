import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt } from '@mesh-flow/core'
import { describe, expect, test, vi } from 'vitest'
import { runCheck } from '../../core/src/check/check.mts'
import { githubHostTools } from '../src/host/connector.mts'
import { checksPass } from '../src/pull-request/checks-pass.mts'
import { openPullRequest } from '../src/pull-request/pull-request.mts'
import { reply } from '../src/pull-request/reply.mts'
import { review } from '../src/pull-request/review.mts'
import { close, collect, comment, label } from '../src/issue/issue.mts'
import { push } from '../src/repository/push.mts'
import { checkout } from '../src/repository/repository.mts'
import { fakeGithub, shaOf } from './support/fake-github.mts'
import { git, localRemote } from './support/local-remote.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { runOnGateway, testGateway, testToken } from './support/test-run.mts'

const repositoryName = 'team/app'

/** A fake GitHub, a local remote standing in for its git side, and a gateway with the connector's host tools on them. */
async function connected() {
	const api = await fakeGithub()
	const remote = await localRemote()
	const gateway = await testGateway(
		githubHostTools({ directory: await temporaryDirectory(), apiUrl: api.url, remoteUrl: () => remote.url }),
	)
	return { api, remote, gateway }
}

describe('github', () => {
	test('collects an issue into the workspace, renders it as the dump, and comments, labels and closes it on the host', async () => {
		// Arrange
		const { api, gateway } = await connected()
		api.issue(repositoryName, 7, {
			title: 'Login fails on Safari',
			body: 'Steps: open the login page in Safari.',
			labels: [{ name: 'bug' }],
		})

		// Act
		const run = await runOnGateway(gateway, async () => {
			const issue = await collect({ repository: repositoryName, number: 7 })
			await comment(issue, 'On it.', { key: 'status' })
			await comment(issue, 'Still on it.', { key: 'status' })
			await label(issue, ['ai-fix'])
			await close(issue)
			return { issue, rendered: issue[toPrompt]() }
		})
		const { issue, rendered } = await run.result

		// Assert
		expect(rendered).toBe('issues/team--app-7.md')
		expect(issue.title).toBe('Login fails on Safari')
		const dump = await readFile(path.join(run.workspace, issue.path), 'utf8')
		expect(dump).toContain('# #7: Login fails on Safari')
		expect(dump).toContain('- Labels: bug')
		expect(dump).toContain('Steps: open the login page in Safari.')
		const stored = api.issue(repositoryName, 7)
		expect(stored.comments.map((posted) => posted.body)).toEqual(['Still on it.\n\n<!-- mesh-flow:status -->'])
		expect(stored.labels.map((known) => known.name)).toEqual(['bug', 'ai-fix'])
		expect(stored.state).toBe('closed')
		expect(api.tokens).toEqual(new Set([testToken]))
	})

	test('checks out on a new branch, pushes commits through the host, and opens one pull request for them', async () => {
		// Arrange
		const { api, remote, gateway } = await connected()

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'fix.txt'), 'fixed\n')
			const pushed = await push(repository)({ message: 'Fix the login' })
			const nothing = await push(repository)({ message: 'Nothing changed' })
			const opened = await openPullRequest(repository, { title: 'Fix the login', description: 'Fixes #7' })
			const again = await openPullRequest(repository, { title: 'Fix the login', description: 'Fixes #7' })
			const same = await checkout({ repository: repositoryName, branch: 'fix/7' })
			return { repository, pushed, nothing, opened, again, same, rendered: repository[toPrompt]() }
		})
		const result = await run.result

		// Assert
		expect(result.rendered).toBe('app')
		expect(result.repository.directory).toBe(path.join(run.workspace, 'app'))
		expect(result.pushed).toMatchObject({ pushed: true, head: await remote.head('fix/7') })
		expect(result.nothing).toMatchObject({ pushed: false })
		expect(await remote.files('fix/7')).toEqual(['README.md', 'fix.txt'])
		expect((await git(result.repository.directory, 'log', '--format=%an %s', 'fix/7')).split('\n')).toEqual([
			'mesh-flow Fix the login',
			'Test Start',
		])
		expect(result.opened).toMatchObject({ number: 1, head: { branch: 'fix/7' }, base: 'main' })
		expect(result.again.number).toBe(1)
		expect(api.repository(repositoryName).pulls.size).toBe(1)
		expect(result.same.directory).toBe(result.repository.directory)
	})

	test('pushes on top of a branch that exists on GitHub', async () => {
		// Arrange
		const { remote, gateway } = await connected()
		await remote.commit('fix/7', 'earlier.txt', 'earlier\n')

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'later.txt'), 'later\n')
			return push(repository)({ message: 'Later' })
		})
		await run.result

		// Assert
		expect(await remote.files('fix/7')).toEqual(['README.md', 'earlier.txt', 'later.txt'])
	})

	test('watches a pull request: hands new review items to the handler, leaves its own out, and ends when it is merged', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const pull = api.pullRequest(repositoryName, 3, { head: { ref: 'fix/7', sha: shaOf('fix/7') } })
		const at = new Date().toISOString()
		pull.reviewComments.push({
			id: 1,
			body: 'Rename this.',
			user: { login: 'reviewer' },
			html_url: `${pull.html_url}#r1`,
			created_at: at,
			path: 'fix.txt',
			line: 1,
		})
		pull.comments.push({ id: 2, body: 'Working on it.', user: { login: api.self }, html_url: `${pull.html_url}#c2`, created_at: at })
		const comments = vi.fn<(items: readonly { id: string; body: string }[]) => Promise<void>>(async (items) => {
			await reply({ repository: repositoryName, number: 3 })({ item: items[0]?.id ?? '', text: 'Renamed.' })
			pull.merged = true
			pull.state = 'closed'
		})

		// Act
		const run = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 3 }, { comments }))

		// Assert
		await expect(run.result).resolves.toMatchObject({ state: 'merged', pullRequest: { number: 3, merged: true } })
		expect(comments).toHaveBeenCalledTimes(1)
		expect(comments.mock.calls[0]?.[0]).toMatchObject([
			{ id: 'review-comment/1', kind: 'review-comment', author: 'reviewer', body: 'Rename this.', path: 'fix.txt', line: 1 },
		])
		expect(pull.reviewComments.map((posted) => [posted.body, posted.in_reply_to_id])).toEqual([
			['Rename this.', undefined],
			['Renamed.', 1],
		])
		expect(run.wakes).toBeGreaterThanOrEqual(1)
	})

	test('reports failed checks once per commit, and checksPass waits for them as findings', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const sha = shaOf('fix/7')
		const pull = api.pullRequest(repositoryName, 4, { head: { ref: 'fix/7', sha } })
		const checks = api.repository(repositoryName).checks
		checks.set(sha, [{ name: 'tests', status: 'in_progress', conclusion: null, html_url: null, output: { title: null, summary: null } }])
		const checksFailed = vi.fn<(failed: { sha: string }) => Promise<void>>(async () => {
			pull.state = 'closed'
			await Promise.resolve()
		})
		const complete = () => {
			checks.set(sha, [
				{
					name: 'tests',
					status: 'completed',
					conclusion: 'failure',
					html_url: 'https://ci.example/1',
					output: { title: 'Tests', summary: '2 failed' },
				},
				{ name: 'lint', status: 'completed', conclusion: 'success', html_url: null, output: { title: null, summary: null } },
			])
		}

		// Act
		const checked = await runOnGateway(gateway, ({ abortSignal }) => {
			setTimeout(complete, 100)
			return runCheck(checksPass({ repository: repositoryName, number: 4 }, { every: { seconds: 1 } }), { abortSignal })
		})
		const findings = await checked.result
		const watched = await runOnGateway(gateway, () => review({ repository: repositoryName, number: 4 }, { checksFailed }))
		await watched.result

		// Assert
		expect(findings).toEqual([{ source: 'check: tests', message: '2 failed (https://ci.example/1)' }])
		expect(checksFailed).toHaveBeenCalledTimes(1)
		expect(checksFailed.mock.calls[0]?.[0]).toMatchObject({
			sha,
			failures: [{ name: 'tests', summary: '2 failed', url: 'https://ci.example/1' }],
		})
	})
})
