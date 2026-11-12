import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt } from '@mesh-flow/core'
import { describe, expect, test } from 'vitest'
import { collect } from '../src/issue/issue.mts'
import { describe as describeBranch } from '../src/pull-request/describe.mts'
import { openPullRequest } from '../src/pull-request/pull-request.mts'
import { push } from '../src/repository/push.mts'
import { checkout } from '../src/repository/repository.mts'
import {
	branch,
	changeLogin,
	connectedGithub,
	firstPullRequest,
	issueRef,
	promptlyMs,
	repositoryName,
	sameSite,
} from './support/connected-github.mts'
import { git } from './support/local-remote.mts'
import { scriptedWriter } from './support/scripted-writer.mts'
import { runOnGateway } from './support/test-run.mts'

describe('describe', () => {
	test('asks the agent about the commits, the diff, the issue, the template and the lint settings', async () => {
		// Arrange
		const { remote, gateway } = await connectedGithub()
		await remote.commit('main', '.github/PULL_REQUEST_TEMPLATE.md', '## Summary\n\n- [ ] Tests added\n')
		await remote.commit('main', 'commitlint.config.mjs', "export default { extends: ['@commitlint/config-conventional'] }\n")
		await remote.commit('main', '.github/workflows/pr-title.yml', 'steps:\n  - uses: amannn/action-semantic-pull-request@v5\n')
		await remote.commit('main', '.github/workflows/build.yml', 'steps:\n  - run: pnpm test\n')
		const { writer, prompts } = scriptedWriter([sameSite])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const issue = await collect(issueRef)
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			const { head } = await push(repository)({ message: 'Set SameSite on the session cookie\n\nSafari drops it otherwise.' })
			const content = await describeBranch(writer, repository, { issue })
			return { issue, head, content }
		})
		const { issue, head, content } = await run.result

		// Assert
		const [asked] = prompts
		expect(asked).toContain('merges branch `fix/7` of\nteam/app into `main`')
		expect(asked).toContain(`at commit ${head}`)
		expect(asked).toContain(issue[toPrompt]())
		expect(asked).toContain('- Set SameSite on the session cookie\nSafari drops it otherwise.')
		expect(asked).toContain('login.txt | 1 +')
		expect(asked).toContain('nobody cares what happened on the way there')
		expect(asked).toContain('.github/PULL_REQUEST_TEMPLATE.md:\n`````\n## Summary\n\n- [ ] Tests added\n`````')
		expect(asked).toContain("commitlint.config.mjs:\n`````\nexport default { extends: ['@commitlint/config-conventional'] }\n`````")
		expect(asked).toContain('.github/workflows/pr-title.yml:')
		expect(asked).not.toContain('build.yml')
		expect(content).toEqual({ ...sameSite, describedSha: head, closes: issue })
	})

	test('writes the whole diff into a file in the workspace, which the prompt names', async () => {
		// Arrange
		const { gateway } = await connectedGithub()
		const { writer, prompts } = scriptedWriter([sameSite])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			await push(repository)({ message: 'Set SameSite' })
			return describeBranch(writer, repository)
		})
		await run.result

		// Assert
		const diffFile = path.join(run.workspace, 'pull-requests/app/fix/7.diff')
		expect(prompts[0]).toContain(diffFile)
		expect(await readFile(diffFile, 'utf8')).toContain('+SameSite=None')
	})

	test('asks for a default shape without a template', async () => {
		// Arrange
		const { gateway } = await connectedGithub()
		const { writer, prompts } = scriptedWriter([sameSite])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			await push(repository)({ message: 'Set SameSite' })
			return describeBranch(writer, repository)
		})
		await run.result

		// Assert
		expect(prompts[0]).toContain('no pull request template')
		expect(prompts[0]).toContain('`## What changes`, `## Why` and `## Testing`')
	})

	test('asks for a short title without lint settings', async () => {
		// Arrange
		const { gateway } = await connectedGithub()
		const { writer, prompts } = scriptedWriter([sameSite])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			await push(repository)({ message: 'Set SameSite' })
			return describeBranch(writer, repository)
		})
		await run.result

		// Assert
		expect(prompts[0]).toContain('under 72 characters')
		expect(prompts[0]).not.toContain('lints commit messages')
	})

	test('reads the template and the lint settings as the default branch has them, not as the branch changed them', async () => {
		// Arrange
		const { gateway } = await connectedGithub()
		const { writer, prompts } = scriptedWriter([{ title: 'Change the template', description: 'Changes it.' }])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await writeFile(path.join(repository.directory, 'pull_request_template.md'), '## Made on the branch\n')
			await push(repository)({ message: 'Add a template' })
			return describeBranch(writer, repository)
		})
		await run.result

		// Assert
		expect(prompts[0]).toContain('no pull request template')
		expect(prompts[0]).not.toContain('## Made on the branch')
	})

	test('describes what is committed, without what is left uncommitted or untracked', async () => {
		// Arrange
		const { gateway } = await connectedGithub()
		const { writer, prompts } = scriptedWriter([sameSite])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			await push(repository)({ message: 'Set SameSite' })
			await writeFile(path.join(repository.directory, 'README.md'), '# Changed\n')
			await writeFile(path.join(repository.directory, 'coverage.json'), '{}\n')
			return describeBranch(writer, repository)
		})
		await run.result

		// Assert
		expect(prompts[0]).toContain('login.txt | 1 +')
		expect(prompts[0]).not.toContain('README.md')
		expect(prompts[0]).not.toContain('coverage.json')
	})

	test('refuses a branch without commits of its own, before the agent spends a loop on it', async () => {
		// Arrange
		const { gateway } = await connectedGithub()
		const { writer, prompts } = scriptedWriter([sameSite])

		// Act
		const run = await runOnGateway(gateway, async () => describeBranch(writer, await checkout({ repository: repositoryName, branch })))

		// Assert
		await expect(run.result).rejects.toThrow('fix/7 has no commits on top of main')
		expect(prompts).toHaveLength(0)
	})

	test('describes a pull request again from its current text, for the branch as it was pushed', async () => {
		// Arrange
		const { gateway } = await connectedGithub()
		const { writer, prompts } = scriptedWriter([
			{ title: 'Keep the session on Safari and Firefox', description: 'Sets SameSite and Secure.' },
		])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			const pullRequest = await openPullRequest(repository, sameSite)
			await changeLogin(repository, 'SameSite=None; Secure\n')
			const { head } = await push(repository)({ message: 'Set Secure too' })
			// Committed in the checkout, but never pushed: the pull request doesn't show it.
			await changeLogin(repository, 'SameSite=Lax\n')
			await git(repository.directory, 'commit', '--quiet', '-am', 'Unpushed')
			const content = await describeBranch(writer, repository, { pullRequest })
			return { head, content }
		})
		const { head, content } = await run.result

		// Assert
		expect(prompts[0]).toContain('Start from them')
		expect(prompts[0]).toContain('Title: Keep the session on Safari\nDescription:\n`````\nSets SameSite.\n`````')
		expect(content).toMatchObject({ title: 'Keep the session on Safari and Firefox', describedSha: head })
	})

	test('runs no loop when the pull request already describes the pushed commit', async () => {
		// Arrange
		const { gateway } = await connectedGithub()
		const { writer, prompts } = scriptedWriter([])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			const pullRequest = await openPullRequest(repository, { ...sameSite, closes: issueRef })
			return describeBranch(writer, repository, { pullRequest })
		})
		const content = await run.result

		// Assert
		expect(prompts).toHaveLength(0)
		expect(content).toMatchObject(sameSite)
	})

	test('runs no loop for a closed pull request, and gives its text back', async () => {
		// Arrange
		const { api, gateway } = await connectedGithub()
		const { writer, prompts } = scriptedWriter([])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			const pullRequest = await openPullRequest(repository, sameSite)
			await changeLogin(repository, 'SameSite=None; Secure\n')
			await push(repository)({ message: 'Set Secure too' })
			api.pullRequest(repositoryName, pullRequest.number, { state: 'closed' })
			return describeBranch(writer, repository, { pullRequest })
		})
		const content = await run.result

		// Assert
		expect(prompts).toHaveLength(0)
		expect(content).toMatchObject(sameSite)
	})

	test('starts from the text of a pull request a person wrote, without cutting at its own `---` rule', async () => {
		// Arrange
		const { api, gateway } = await connectedGithub()
		const { writer, prompts } = scriptedWriter([sameSite])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			const pullRequest = await openPullRequest(repository, { title: 'Keep the session', description: 'Sets it.' })
			api.pullRequest(repositoryName, pullRequest.number, { body: 'Sets the cookie.\r\n\r\n---\r\nNotes of my own.' })
			return describeBranch(writer, repository, { pullRequest })
		})
		await run.result

		// Assert
		expect(prompts[0]).toContain('Description:\n`````\nSets the cookie.\n\n---\nNotes of my own.\n`````')
	})

	test('refuses a pull request of another branch', async () => {
		// Arrange
		const { gateway } = await connectedGithub()
		const { writer } = scriptedWriter([])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			const pullRequest = await openPullRequest(repository, sameSite)
			const other = await checkout({ repository: repositoryName, branch: 'fix/8' })
			return describeBranch(writer, other, { pullRequest })
		})

		// Assert
		await expect(run.result).rejects.toThrow('is the pull request of fix/7, not of team/app fix/8')
	})

	test('refuses a pull request onto another branch than the default one', async () => {
		// Arrange
		const { api, gateway } = await connectedGithub()
		const { writer } = scriptedWriter([])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			const pullRequest = await openPullRequest(repository, sameSite)
			api.pullRequest(repositoryName, pullRequest.number, { base: { ref: 'release/1' } })
			return describeBranch(writer, repository, { pullRequest })
		})

		// Assert
		await expect(run.result).rejects.toThrow('merges into release/1, not into main')
	})

	test('settles promptly when the run stops while GitHub never answers the read of the pull request', async () => {
		// Arrange
		const { api, gateway } = await connectedGithub()
		const { writer } = scriptedWriter([])
		const { promise: stalled, resolve } = Promise.withResolvers<undefined>()
		api.hold = (method, requestPath) => {
			if (method !== 'GET' || !requestPath.endsWith(`/pulls/${firstPullRequest}`)) return undefined
			resolve(undefined)
			return new Promise(() => undefined)
		}

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: repositoryName, branch })
			await changeLogin(repository, 'SameSite=None\n')
			const pullRequest = await openPullRequest(repository, sameSite)
			return describeBranch(writer, repository, { pullRequest })
		})
		await stalled
		const started = performance.now()
		run.controller.abort(new Error('The run stopped.'))
		await run.outcome

		// Assert
		expect(performance.now() - started).toBeLessThan(promptlyMs)
	})
})
