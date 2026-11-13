import { signed } from '@mesh-flow/code-repository/host'
import { describe, expect, test } from 'vitest'
import { mergedMergeRequest, mergeRequest, openMergeRequest, updateMergeRequest } from '../src/merge-request/merge-request.mts'
import { checkout } from '../src/repository/repository.mts'
import { searchRepositories } from '../src/repository/search.mts'
import { forkProjectId } from './support/fake-gitlab.mts'
import {
	branch,
	changeLogin,
	connectedGitlab,
	firstMergeRequest,
	projectPath,
	promptlyMs,
	sameSite,
	story,
} from './support/connected-gitlab.mts'
import { runOnGateway, testToken } from './support/test-run.mts'

/** The text after the second fix, which adds Secure to the cookie. */
const secure = { title: 'Keep the session on Safari and Firefox', description: 'Sets SameSite and Secure.' }

describe('openMergeRequest', () => {
	test('pushes the branch and opens a merge request signed with the run id, the issue it closes and the commit it describes', async () => {
		// Arrange
		const { api, remote, gateway } = await connectedGitlab()

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: projectPath, branch })
			await changeLogin(repository, 'SameSite=None\n')
			const opened = await openMergeRequest(repository, { ...sameSite, closes: story })
			return { opened, head: await remote.head(branch) }
		})
		const { opened, head } = await run.result

		// Assert
		const made = api.mergeRequest(projectPath, firstMergeRequest)
		expect(made).toMatchObject({ title: sameSite.title, source_branch: branch, target_branch: 'main' })
		expect(made.description).toBe(signed('Sets SameSite.', run.runId, [`described:${head}`], ['Fixes PROJ-7']))
		expect(opened).toMatchObject({ repository: projectPath, number: firstMergeRequest, description: 'Sets SameSite.', describedSha: head })
		expect(await remote.files(branch)).toContain('login.txt')
		expect(api.tokens).toEqual(new Set([testToken]))
	})

	test('keeps the text of the open merge request when it is opened again for the same commit', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: projectPath, branch })
			await changeLogin(repository, 'SameSite=None\n')
			await openMergeRequest(repository, sameSite)
			return openMergeRequest(repository, secure)
		})
		const reopened = await run.result

		// Assert
		expect(reopened.title).toBe(sameSite.title)
		expect(api.project(projectPath).mergeRequests.size).toBe(1)
	})

	test('gives the open merge request the new text when it is opened again for a new commit', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: projectPath, branch })
			await changeLogin(repository, 'SameSite=None\n')
			await openMergeRequest(repository, sameSite)
			await changeLogin(repository, 'SameSite=None; Secure\n')
			return openMergeRequest(repository, secure)
		})
		await run.result

		// Assert
		expect(api.mergeRequest(projectPath, firstMergeRequest).title).toBe(secure.title)
		expect(api.project(projectPath).mergeRequests.size).toBe(1)
	})

	test('takes the merge request another run opened for the branch meanwhile', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.hold = (method, requestPath) => {
			if (method === 'POST' && requestPath.endsWith('/merge_requests') && api.project(projectPath).mergeRequests.size === 0)
				api.mergeRequest(projectPath, firstMergeRequest, { source_branch: branch, target_branch: 'main', title: 'Opened meanwhile' })
			return undefined
		}

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: projectPath, branch })
			await changeLogin(repository, 'SameSite=None\n')
			return openMergeRequest(repository, sameSite)
		})
		const opened = await run.result

		// Assert
		expect(opened).toMatchObject({ number: firstMergeRequest, title: 'Opened meanwhile' })
		expect(api.project(projectPath).mergeRequests.size).toBe(1)
	})

	test("opens its own merge request next to one from a fork's branch of the same name", async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, firstMergeRequest, { source_branch: branch, source_project_id: forkProjectId, title: 'From a fork' })

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: projectPath, branch })
			await changeLogin(repository, 'SameSite=None\n')
			return openMergeRequest(repository, sameSite)
		})
		const opened = await run.result

		// Assert
		expect(opened).toMatchObject({ number: firstMergeRequest + 1, title: sameSite.title })
		expect(api.mergeRequest(projectPath, firstMergeRequest).title).toBe('From a fork')
	})

	test('keeps a merge request a person marked as a draft a draft when it gets new text', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: projectPath, branch })
			await changeLogin(repository, 'SameSite=None\n')
			const opened = await openMergeRequest(repository, sameSite)
			api.mergeRequest(projectPath, opened.number, { title: `Draft: ${sameSite.title}` })
			await changeLogin(repository, 'SameSite=None; Secure\n')
			return openMergeRequest(repository, secure)
		})
		await run.result

		// Assert
		expect(api.mergeRequest(projectPath, firstMergeRequest).title).toBe(`Draft: ${secure.title}`)
	})

	test('fails, naming it, when the branch has an open merge request onto another branch', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		const other = api.mergeRequest(projectPath, firstMergeRequest, { source_branch: branch, target_branch: 'release' })

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: projectPath, branch })
			await changeLogin(repository, 'SameSite=None\n')
			return openMergeRequest(repository, sameSite)
		})

		// Assert
		await expect(run.result).rejects.toThrow(`onto release, not main: ${other.web_url}`)
	})

	test('settles promptly when the run stops while GitLab never answers', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		const { promise: stalled, resolve } = Promise.withResolvers<undefined>()
		api.hold = (method, requestPath) => {
			if (method !== 'POST' || !requestPath.endsWith('/merge_requests')) return undefined
			resolve(undefined)
			return new Promise(() => undefined)
		}

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: projectPath, branch })
			await changeLogin(repository, 'SameSite=None\n')
			return openMergeRequest(repository, sameSite)
		})
		await stalled
		const started = performance.now()
		run.controller.abort(new Error('The run stopped.'))
		await run.outcome

		// Assert
		expect(performance.now() - started).toBeLessThan(promptlyMs)
	})
})

describe('updateMergeRequest', () => {
	test('writes the new text, and skips a merge request that already has it', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout({ repository: projectPath, branch })
			await changeLogin(repository, 'SameSite=None\n')
			const opened = await openMergeRequest(repository, sameSite)
			const first = await updateMergeRequest(opened, secure)
			const second = await updateMergeRequest(opened, secure)
			return { first, second }
		})
		const { first, second } = await run.result

		// Assert
		expect(first.skipped).toBeUndefined()
		expect(second.skipped).toBe('unchanged')
		expect(api.mergeRequest(projectPath, firstMergeRequest).title).toBe(secure.title)
	})

	test('leaves a merged merge request as it is', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 4, { state: 'merged', title: 'Merged', description: 'As reviewed.' })

		// Act
		const run = await runOnGateway(gateway, async () => {
			const updated = await updateMergeRequest({ repository: projectPath, number: 4 }, secure)
			return { updated, read: await mergeRequest({ repository: projectPath, number: 4 }) }
		})
		const { updated, read } = await run.result

		// Assert
		expect(updated.skipped).toBe('closed')
		expect(read).toMatchObject({ state: 'closed', merged: true, title: 'Merged' })
	})
})

describe('mergedMergeRequest', () => {
	test('finds the latest merge request that merged the branch, after GitLab deleted the branch', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 2, { state: 'merged', source_branch: branch })
		api.mergeRequest(projectPath, 3, { state: 'merged', source_branch: branch })
		api.mergeRequest(projectPath, 4, { state: 'merged', source_branch: branch, source_project_id: forkProjectId })
		api.mergeRequest(projectPath, 5, { state: 'merged', source_branch: 'feature/PROJ-8' })
		api.mergeRequest(projectPath, 6, { state: 'opened', source_branch: branch })

		// Act
		const run = await runOnGateway(gateway, async () => mergedMergeRequest(await checkout({ repository: projectPath, branch })))
		const found = await run.result

		// Assert
		expect(found).toMatchObject({ number: 3, merged: true })
	})

	test('finds none for a branch that was never merged', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.mergeRequest(projectPath, 2, { state: 'closed', source_branch: branch })

		// Act
		const run = await runOnGateway(gateway, async () => mergedMergeRequest(await checkout({ repository: projectPath, branch })))
		const found = await run.result

		// Assert
		expect(found).toBeUndefined()
	})
})

describe('searchRepositories', () => {
	test('finds projects by their path, with what checkout takes', async () => {
		// Arrange
		const { api, gateway } = await connectedGitlab()
		api.project('team/frontend/web', { description: 'The web app' })

		// Act
		const run = await runOnGateway(gateway, () => searchRepositories({ query: 'backend' }))
		const found = await run.result

		// Assert
		expect(found).toEqual({
			projects: [
				{
					repository: projectPath,
					name: 'api',
					description: 'The backend API',
					url: `https://gitlab.example/${projectPath}`,
					defaultBranch: 'main',
				},
			],
			more: false,
		})
	})
})
