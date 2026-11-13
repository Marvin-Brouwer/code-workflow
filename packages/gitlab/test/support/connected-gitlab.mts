import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defaultFetchRetry, type FetchRetryOptions } from '@mesh-flow/forge/host'
import { gitlabHostTools } from '../../src/host/connector.mts'
import type { Repository } from '../../src/repository/repository.mts'
import { fakeGitlab } from './fake-gitlab.mts'
import { localRemote } from './local-remote.mts'
import { temporaryDirectory } from './temporary-directory.mts'
import { testGateway } from './test-run.mts'

/** The project the merge request tests work in. */
export const projectPath = 'team/backend/api'

/** The branch the merge request tests describe. */
export const branch = 'feature/PROJ-7'

/** The Jira issue the branch closes, as `@mesh-flow/atlassian` hands one over. */
export const story = Object.freeze({ key: 'PROJ-7' })

/** The text the tests' agent writes for the fix of `login.txt`. */
export const sameSite = Object.freeze({ title: 'Keep the session on Safari', description: 'Sets SameSite.' })

/** The iid of the first merge request the fake opens. */
export const firstMergeRequest = 1

/** How soon a run that stopped has to settle. */
export const promptlyMs = 1000

/** A fake GitLab, a local remote standing in for its git side, and a gateway with the connector's host tools on them. */
export async function connectedGitlab(retry: FetchRetryOptions = defaultFetchRetry) {
	const api = await fakeGitlab()
	const remote = await localRemote()
	const gateway = await testGateway(gitlabHostTools({ directory: await temporaryDirectory(), remoteUrl: () => remote.url, retry }), api.url)
	api.project(projectPath, { description: 'The backend API' })
	return { api, remote, gateway }
}

/** Changes the checkout's `login.txt`, the file the tests' fixes touch. */
export async function changeLogin(repository: Repository, text: string): Promise<void> {
	await writeFile(path.join(repository.directory, 'login.txt'), text)
}

/** Host retries that are over in a moment. */
export const quickRetry: FetchRetryOptions = { attempts: 3, firstDelayMs: 1, longestRetryAfterMs: 0, attemptTimeoutMs: 1000 }
