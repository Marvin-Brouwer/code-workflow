/**
 * The entry file, which `main` in package.json names: the sandbox the app's runs get, and
 * everything that can start a run. A workflow says what it does and what it starts with; this
 * file says how it gets started and where it runs.
 *
 * The sandbox is the image the Dockerfile next to this file builds: node, git and the .NET 10 SDK.
 * Build it, push it to Docker Hub under an account of yours and name it below. It reaches NuGet,
 * so restores work and the agents can build and test, and nothing else: Jira, Confluence and
 * GitLab are only spoken to from the host, through the gateway.
 */
import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
import { jira } from '@mesh-flow/atlassian/hooks'
import { develop } from './workflows/develop.mts'

/** The image the Dockerfile builds, as pushed to Docker Hub: put your account in. */
const sandboxImage = '<account>/mesh-flow-example:dotnet10'

export default defineMeshFlow({
	sandbox: image({ name: sandboxImage, memoryMb: 4096, egress: ['api.nuget.org'] }),
	workflows: [
		// A button in the UI, with the story's key as its form.
		userTrigger(develop),
		// A Jira webhook: labelling a story `ai-develop` starts a run for it.
		jira.onIssueLabeled(develop, 'ai-develop'),
	],
})
