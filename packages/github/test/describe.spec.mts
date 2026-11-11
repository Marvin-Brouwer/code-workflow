import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt, type Agent } from '@mesh-flow/core'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { githubHostTools } from '../src/host/connector.mts'
import { signed } from '../src/host/signature.mts'
import { collect } from '../src/issue/issue.mts'
import { describe as describeBranch, redescribe } from '../src/pull-request/describe.mts'
import type { PullRequestText } from '../src/pull-request/pull-request-text.mts'
import { openPullRequest, withClosingReference } from '../src/pull-request/pull-request.mts'
import { push } from '../src/repository/push.mts'
import { checkout } from '../src/repository/repository.mts'
import { fakeGithub } from './support/fake-github.mts'
import { localRemote } from './support/local-remote.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'
import { runOnGateway, testGateway } from './support/test-run.mts'

const repositoryName = 'team/app'

async function connected() {
	const api = await fakeGithub()
	const remote = await localRemote()
	const gateway = await testGateway(
		githubHostTools({ directory: await temporaryDirectory(), apiUrl: api.url, remoteUrl: () => remote.url }),
	)
	api.issue(repositoryName, 7, { title: 'Login fails on Safari', body: 'Safari drops the session cookie.' })
	return { api, remote, gateway }
}

const promptParts = Symbol.for('mesh-flow.prompt')
const PromptParts = z.object({ strings: z.array(z.string()), values: z.array(z.unknown()) })

/** How soon a run that stopped has to settle. */
const promptlyMs = 1000

/**
 * A template as the loop would show it, near enough: nested prompts in place, values that render
 * themselves as they do. Every line loses its indentation, where the loop takes off only the source's.
 */
function rendered(strings: readonly string[], values: readonly unknown[]): string {
	return strings.reduce((text, part, index) => {
		if (index === 0) return part
		return `${text}${shown(values[index - 1])}${part}`
	}, '')
}

function shown(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'object' && value !== null && promptParts in value) {
		const { strings, values } = PromptParts.parse(Reflect.get(value, promptParts))
		return rendered(strings, values)
	}
	if ((typeof value === 'object' || typeof value === 'function') && value !== null && toPrompt in value) {
		const render: unknown = Reflect.get(value, toPrompt)
		if (typeof render === 'function') return String(render.call(value))
	}
	if (typeof value === 'function') return value.name
	return '(a value)'
}

/** An agent whose loops answer with `texts`, one each, and keep the prompts they got. */
function scriptedWriter(texts: PullRequestText[]) {
	const prompts: string[] = []
	const loop = (strings: TemplateStringsArray, ...values: unknown[]) => {
		prompts.push(rendered(strings, values).replace(/^[ \t]+/gm, ''))
		const text = texts.shift()
		return text === undefined ? Promise.reject(new Error('The writer has nothing more to write.')) : Promise.resolve(text)
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in for a model: `loop` answers whatever its template asks for
	const writer = { model: 'test-writer', loop, as: () => undefined } as unknown as Agent
	return { writer, prompts }
}

describe('describe', () => {
	test("describes a branch from its commits, its diff and the repository's template and lint settings, and opens the pull request with it", async () => {
		// Arrange
		const { api, remote, gateway } = await connected()
		await remote.commit('main', '.github/PULL_REQUEST_TEMPLATE.md', '## Summary\n\n- [ ] Tests added\n')
		await remote.commit('main', 'commitlint.config.mjs', "export default { extends: ['@commitlint/config-conventional'] }\n")
		await remote.commit('main', '.github/workflows/pr-title.yml', 'steps:\n  - uses: amannn/action-semantic-pull-request@v5\n')
		await remote.commit('main', '.github/workflows/build.yml', 'steps:\n  - run: pnpm test\n')
		const { writer, prompts } = scriptedWriter([{ title: 'fix: keep the session on Safari', description: '## Summary\n\nKeeps it.' }])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const issue = await collect({ repository: repositoryName, number: 7 })
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'login.txt'), 'SameSite=None\n')
			const { head } = await push(repository)({ message: 'Set SameSite on the session cookie\n\nSafari drops it otherwise.' })
			const text = await describeBranch(writer, repository, { issue })
			const pullRequest = await openPullRequest(repository, { ...text, closes: issue })
			return { issue, head, pullRequest }
		})
		const { issue, head, pullRequest } = await run.result

		// Assert
		const [asked] = prompts
		expect(asked).toContain('merges branch `fix/7` of\nteam/app into `main`')
		expect(asked).toContain(issue[toPrompt]())
		expect(asked).toContain('- Set SameSite on the session cookie\nSafari drops it otherwise.')
		expect(asked).toContain('login.txt | 1 +')
		expect(asked).toContain('nobody cares what happened on the way there')
		expect(asked).toContain('.github/PULL_REQUEST_TEMPLATE.md:\n`````\n## Summary\n\n- [ ] Tests added\n`````')
		expect(asked).toContain("commitlint.config.mjs:\n`````\nexport default { extends: ['@commitlint/config-conventional'] }\n`````")
		expect(asked).toContain('.github/workflows/pr-title.yml:')
		expect(asked).not.toContain('build.yml')
		const diffFile = path.join(run.workspace, 'pull-requests/app/fix/7.diff')
		expect(asked).toContain(diffFile)
		expect(await readFile(diffFile, 'utf8')).toContain('+SameSite=None')
		const stored = api.repository(repositoryName).pulls.get(pullRequest.number)
		expect(stored?.title).toBe('fix: keep the session on Safari')
		expect(stored?.body).toBe(signed('## Summary\n\nKeeps it.\n\nFixes #7', run.runId, [`described:${head}`]))
		expect(pullRequest.described).toBe(head)
	})

	test('asks for a default shape without a template, and for a short title without lint settings', async () => {
		// Arrange
		const { gateway } = await connected()
		const { writer, prompts } = scriptedWriter([{ title: 'Keep the session on Safari', description: 'Keeps it.' }])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'login.txt'), 'SameSite=None\n')
			await push(repository)({ message: 'Set SameSite' })
			return describeBranch(writer, repository)
		})
		await run.result

		// Assert
		const [asked] = prompts
		expect(asked).toContain('no pull request template')
		expect(asked).toContain('`## What changes`, `## Why` and `## Testing`')
		expect(asked).toContain('under 72 characters')
		expect(asked).not.toContain('resolves the issue')
	})

	test('reads the template and the lint settings as the default branch has them, not as the branch changed them', async () => {
		// Arrange
		const { gateway } = await connected()
		const { writer, prompts } = scriptedWriter([{ title: 'Change the template', description: 'Changes it.' }])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'pull_request_template.md'), '## Made on the branch\n')
			await push(repository)({ message: 'Add a template' })
			return describeBranch(writer, repository)
		})
		await run.result

		// Assert
		expect(prompts[0]).toContain('no pull request template')
		expect(prompts[0]).not.toContain('## Made on the branch')
	})

	test('describes again only once the branch has commits the description does not cover', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const { writer, prompts } = scriptedWriter([
			{ title: 'Keep the session on Safari', description: 'Sets SameSite.' },
			{ title: 'Keep the session on Safari and Firefox', description: 'Sets SameSite and Secure.' },
		])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const issue = await collect({ repository: repositoryName, number: 7 })
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'login.txt'), 'SameSite=None\n')
			await push(repository)({ message: 'Set SameSite' })
			const pullRequest = await openPullRequest(repository, { ...(await describeBranch(writer, repository, { issue })), closes: issue })
			const unchanged = await redescribe(writer, pullRequest, repository, { issue })
			await writeFile(path.join(repository.directory, 'login.txt'), 'SameSite=None; Secure\n')
			const { head } = await push(repository)({ message: 'Set Secure too' })
			const changed = await redescribe(writer, pullRequest, repository, { issue })
			const again = await redescribe(writer, pullRequest, repository, { issue })
			return { head, unchanged, changed, again }
		})
		const result = await run.result

		// Assert
		expect(prompts).toHaveLength(2)
		expect(result.unchanged.title).toBe('Keep the session on Safari')
		expect(result.changed).toMatchObject({ title: 'Keep the session on Safari and Firefox', described: result.head })
		expect(result.again.described).toBe(result.head)
		const stored = api.repository(repositoryName).pulls.get(1)
		expect(stored?.body).toBe(signed('Sets SameSite and Secure.\n\nFixes #7', run.runId, [`described:${result.head}`]))
	})

	test('leaves a closed pull request alone', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const { writer, prompts } = scriptedWriter([{ title: 'Keep the session on Safari', description: 'Sets SameSite.' }])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'login.txt'), 'SameSite=None\n')
			await push(repository)({ message: 'Set SameSite' })
			const pullRequest = await openPullRequest(repository, { title: 'Keep the session', description: 'Sets it.' })
			api.pullRequest(repositoryName, pullRequest.number, { state: 'closed' })
			return redescribe(writer, pullRequest, repository)
		})
		const closed = await run.result

		// Assert
		expect(prompts).toHaveLength(0)
		expect(closed.state).toBe('closed')
	})

	test('settles promptly when the run stops while GitHub never answers the new description', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const { writer } = scriptedWriter([{ title: 'Keep the session on Safari', description: 'Sets SameSite.' }])
		const { promise: stalled, resolve } = Promise.withResolvers<undefined>()
		api.hold = (method, requestPath) => {
			if (method !== 'PATCH' || !requestPath.endsWith('/pulls/1')) return undefined
			resolve(undefined)
			return new Promise(() => undefined)
		}

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'login.txt'), 'SameSite=None\n')
			const pullRequest = await openPullRequest(repository, { title: 'Keep the session', description: 'Sets it.' })
			await writeFile(path.join(repository.directory, 'login.txt'), 'SameSite=None; Secure\n')
			await push(repository)({ message: 'Set Secure too' })
			return redescribe(writer, pullRequest, repository)
		})
		await stalled
		const started = performance.now()
		run.controller.abort(new Error('The run stopped.'))
		await run.outcome

		// Assert
		expect(performance.now() - started).toBeLessThan(promptlyMs)
	})

	test('gives the open pull request of the branch the new text when it is opened again', async () => {
		// Arrange
		const { api, gateway } = await connected()

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'login.txt'), 'SameSite=None\n')
			await openPullRequest(repository, { title: 'Keep the session', description: 'Sets it.' })
			return openPullRequest(repository, { title: 'Keep the session on Safari', description: 'Sets SameSite.' })
		})
		const reopened = await run.result

		// Assert
		const pulls = api.repository(repositoryName).pulls
		expect(pulls.size).toBe(1)
		expect(reopened.title).toBe('Keep the session on Safari')
		expect(pulls.get(1)?.body.startsWith('Sets SameSite.\n\n---\n')).toBe(true)
	})
})

describe('withClosingReference', () => {
	test('closes an issue of the same repository by number, and one of another repository by its full name', () => {
		// Act
		const same = withClosingReference('Fixes the login.', { repository: 'team/app', number: 7 }, 'team/app')
		const other = withClosingReference('Fixes the login.', { repository: 'team/web', number: 3 }, 'team/app')
		const none = withClosingReference('Fixes the login.', undefined, 'team/app')

		// Assert
		expect([same, other, none]).toEqual(['Fixes the login.\n\nFixes #7', 'Fixes the login.\n\nFixes team/web#3', 'Fixes the login.'])
	})
})
