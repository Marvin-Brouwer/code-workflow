import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { githubHostTools } from '../../src/host/connector.mts'
import type { Repository } from '../../src/repository/repository.mts'
import { fakeGithub } from './fake-github.mts'
import { localRemote } from './local-remote.mts'
import { temporaryDirectory } from './temporary-directory.mts'
import { testGateway } from './test-run.mts'

/** The repository the pull request tests work in. */
export const repositoryName = 'team/app'

/** The branch the pull request tests describe. */
export const branch = 'fix/7'

/** The issue the branch fixes, which {@link connectedGithub} files. */
export const issueRef = Object.freeze({ repository: repositoryName, number: 7 })

/** The text the tests' agent writes for the fix of `login.txt`. */
export const sameSite = Object.freeze({ title: 'Keep the session on Safari', description: 'Sets SameSite.' })

/** The number of the first pull request the fake opens. */
export const firstPullRequest = 1

/** How soon a run that stopped has to settle. */
export const promptlyMs = 1000

/** A fake GitHub with issue #7, a local remote standing in for its git side, and a gateway with the connector's host tools on them. */
export async function connectedGithub() {
	const api = await fakeGithub()
	const remote = await localRemote()
	const gateway = await testGateway(
		githubHostTools({ directory: await temporaryDirectory(), apiUrl: api.url, remoteUrl: () => remote.url }),
	)
	api.issue(repositoryName, issueRef.number, { title: 'Login fails on Safari', body: 'Safari drops the session cookie.' })
	return { api, remote, gateway }
}

/** Changes the checkout's `login.txt`, the file the tests' fixes touch. */
export async function changeLogin(repository: Repository, text: string): Promise<void> {
	await writeFile(path.join(repository.directory, 'login.txt'), text)
}
