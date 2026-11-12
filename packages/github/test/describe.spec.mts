import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt, type Agent } from '@mesh-flow/core'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { githubHostTools } from '../src/host/connector.mts'
import { signed } from '../src/host/signature.mts'
import { collect } from '../src/issue/issue.mts'
import { describe as describeBranch } from '../src/pull-request/describe.mts'
import type { PullRequestText } from '../src/pull-request/pull-request-text.mts'
import { closingReference, openPullRequest, updatePullRequest } from '../src/pull-request/pull-request.mts'
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
		expect(stored?.body).toBe(signed('## Summary\n\nKeeps it.', run.runId, [`described:${head}`], ['Fixes #7']))
		expect(pullRequest).toMatchObject({ described: head, description: '## Summary\n\nKeeps it.' })
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

	test('describes again from the current text, and only once the branch has commits it does not cover', async () => {
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
			const describeAgain = async () =>
				updatePullRequest(pullRequest, { ...(await describeBranch(writer, repository, { issue, pullRequest })), closes: issue })
			const unchanged = await describeAgain()
			await writeFile(path.join(repository.directory, 'login.txt'), 'SameSite=None; Secure\n')
			const { head } = await push(repository)({ message: 'Set Secure too' })
			const changed = await describeAgain()
			const again = await describeAgain()
			return { head, unchanged, changed, again }
		})
		const result = await run.result

		// Assert
		expect(prompts).toHaveLength(2)
		expect(prompts[1]).toContain('Start from them')
		expect(prompts[1]).toContain('Title: Keep the session on Safari\nDescription:\n`````\nSets SameSite.\n`````')
		expect(result.unchanged).toMatchObject({ title: 'Keep the session on Safari', skipped: 'unchanged' })
		expect(result.changed).toMatchObject({ title: 'Keep the session on Safari and Firefox', described: result.head })
		expect(result.changed.skipped).toBeUndefined()
		expect(result.again).toMatchObject({ described: result.head, skipped: 'unchanged' })
		const stored = api.repository(repositoryName).pulls.get(1)
		expect(stored?.body).toBe(signed('Sets SameSite and Secure.', run.runId, [`described:${result.head}`], ['Fixes #7']))
	})

	test('leaves a closed pull request as it is: no loop, and nothing written', async () => {
		// Arrange
		const { api, gateway } = await connected()
		const { writer, prompts } = scriptedWriter([{ title: 'Keep the session on Safari', description: 'Sets SameSite.' }])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch: 'fix/7' })
			await writeFile(path.join(repository.directory, 'login.txt'), 'SameSite=None\n')
			const pullRequest = await openPullRequest(repository, { title: 'Keep the session', description: 'Sets it.' })
			await writeFile(path.join(repository.directory, 'login.txt'), 'SameSite=None; Secure\n')
			await push(repository)({ message: 'Set Secure too' })
			api.pullRequest(repositoryName, pullRequest.number, { state: 'closed' })
			const text = await describeBranch(writer, repository, { pullRequest })
			const updated = await updatePullRequest(pullRequest, { title: 'Something else', description: 'Else.' })
			return { text, updated }
		})
		const { text, updated } = await run.result

		// Assert
		expect(prompts).toHaveLength(0)
		expect(text).toMatchObject({ title: 'Keep the session', description: 'Sets it.' })
		expect(updated).toMatchObject({ state: 'closed', skipped: 'closed', title: 'Keep the session' })
		expect(api.repository(repositoryName).pulls.get(1)?.title).toBe('Keep the session')
	})

	test('settles promptly when the run stops while GitHub never answers the new description', async () => {
		// Arrange
		const { api, gateway } = await connected()
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
			return updatePullRequest(pullRequest, { title: 'Keep the session on Safari', description: 'Sets SameSite.' })
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

describe('closingReference', () => {
	test('names an issue of the same repository by number, and one of another repository by its full name', () => {
		// Act
		const same = closingReference({ repository: 'team/app', number: 7 }, 'team/app')
		const other = closingReference({ repository: 'team/web', number: 3 }, 'team/app')

		// Assert
		expect([same, other]).toEqual(['#7', 'team/web#3'])
	})
})
