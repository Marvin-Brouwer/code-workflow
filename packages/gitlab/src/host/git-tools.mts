import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { cloneRepository, pushBundle } from '../tools/git-tools.mts'
import type { GitRemote } from './git-remote.mts'

/** The host halves of the git tools: they hold the credential, the sandbox holds the commits. */
export function gitHostTools(remote: GitRemote): HostTool[] {
	return [
		hostTool(cloneRepository, async ({ repository, branch }, context) => {
			const fetched = await remote.fetchBundle(repository, branch, context)
			return { bundle: fetched.bundle.toString('base64'), defaultBranch: fetched.defaultBranch, branchExists: fetched.branchExists }
		}),
		hostTool(pushBundle, async ({ repository, branch, bundle }, context) => ({
			head: await remote.pushBundle(repository, branch, Buffer.from(bundle, 'base64'), context),
		})),
	]
}
