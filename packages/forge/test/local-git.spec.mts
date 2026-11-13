import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { committer, localGit } from '../src/checkout/local-git.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

describe('localGit', () => {
	test('commits as mesh-flow, whatever identity the environment sets', async () => {
		// Arrange
		vi.stubEnv('GIT_AUTHOR_NAME', 'Someone Else')
		vi.stubEnv('GIT_COMMITTER_EMAIL', 'someone@example.com')
		onTestFinished(() => {
			vi.unstubAllEnvs()
		})
		const git = localGit(await temporaryDirectory(), new AbortController().signal)
		await git.init({ branch: 'main', quiet: true })
		await writeFile(path.join(git.cwd, 'README.md'), '# Example\n')
		await git.add()

		// Act
		await git.commit({ message: 'Start', quiet: true })

		// Assert
		const signed = (await git.log('-1', '--format=%an <%ae> / %cn <%ce>')).stdout.trim()
		const expected = `${committer.name} <${committer.email}>`
		expect(signed).toBe(`${expected} / ${expected}`)
	})
})
