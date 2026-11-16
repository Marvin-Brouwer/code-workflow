import { describe, expect, test } from 'vitest'
import { describe as describeBranch } from '../src/merge-request/describe.mts'
import { openMergeRequest } from '../src/merge-request/merge-request.mts'
import { push } from '../src/repository/push.mts'
import { checkout } from '../src/repository/repository.mts'
import { branch, changeLogin, connectedGitlab, firstMergeRequest, projectPath, sameSite, story } from './support/connected-gitlab.mts'
import { scriptedWriter } from './support/scripted-writer.mts'
import { runOnGateway } from './support/test-run.mts'

describe('describe', () => {
	test("asks the agent about the commits, the diff, the issue, the project's merge request template and its lint settings", async () => {
		// Arrange
		const { remote, gateway } = await connectedGitlab()
		await remote.commit('main', '.gitlab/merge_request_templates/Default.md', '## Summary\n\n- [ ] Tests added\n')
		await remote.commit('main', '.gitlab-ci.yml', 'lint-title:\n  script: npx commitlint --from HEAD~1\n')
		await remote.commit('main', '.gitlab/ci/build.yml', 'build:\n  script: dotnet build\n')
		const { writer, prompts } = scriptedWriter([sameSite])
		const issue = story

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout(projectPath, { branch })
			await changeLogin(repository, 'SameSite=None\n')
			const { head } = await push(repository)({ message: 'Set SameSite on the session cookie' })
			return { content: await describeBranch(writer, repository, { closes: issue }), head }
		})
		const { content, head } = await run.result

		// Assert
		expect(content).toMatchObject({ ...sameSite, describedSha: head, closes: issue })
		const [asked] = prompts
		expect(asked).toContain('Write the title and the description of the merge request that merges branch `feature/PROJ-7`')
		expect(asked).toContain('- Set SameSite on the session cookie')
		expect(asked).toContain('The repository has a merge request template: fill it in.')
		expect(asked).toContain('.gitlab/merge_request_templates/Default.md:')
		expect(asked).toContain('lints commit messages or merge request titles')
		expect(asked).toContain('.gitlab-ci.yml:')
		expect(asked).not.toContain('dotnet build')
	})

	test('runs no loop when the open merge request already describes the commit', async () => {
		// Arrange
		const { gateway } = await connectedGitlab()
		const { writer, prompts } = scriptedWriter([sameSite])

		// Act
		const run = await runOnGateway(gateway, async () => {
			const repository = await checkout(projectPath, { branch })
			await changeLogin(repository, 'SameSite=None\n')
			await push(repository)({ message: 'Set SameSite' })
			await openMergeRequest(repository, await describeBranch(writer, repository))
			return describeBranch(writer, repository, { mergeRequest: { repository: projectPath, number: firstMergeRequest } })
		})
		const again = await run.result

		// Assert
		expect(prompts).toHaveLength(1)
		expect(again).toMatchObject({ ...sameSite, basedOn: { repository: projectPath, number: firstMergeRequest } })
	})
})
