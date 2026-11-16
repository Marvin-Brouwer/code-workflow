/**
 * The entry file, which `main` in package.json names: the sandbox the app's runs get, and
 * everything that can start a run. A workflow says what it does and what it starts with; this
 * file says how it gets started and where it runs.
 *
 * The sandbox is meant to be the image the Dockerfile next to this file builds; see `sandboxImage`.
 * It reaches NuGet, so restores work, and nothing else: Jira, Confluence and GitLab are only
 * spoken to from the host, through the gateway.
 */
import { jira } from '@mesh-flow/atlassian/hooks'
import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
import { develop } from './workflows/develop.mts'

/** The Jira label that starts a run for a story. */
const startLabel = 'ai-develop'

/**
 * A public stand-in for the image the Dockerfile builds: the same base, with node and git but
 * without the .NET 10 SDK, so the dotnet tools and checks fail on it. Name the built image here once
 * it's pushed, such as `<account>/mesh-flow-big-repo:dotnet10`.
 */
const sandboxImage = 'node:26-bookworm'

export default defineMeshFlow({
	sandbox: image({ name: sandboxImage, memoryMb: 4096, registries: ['nuget'] }),
	workflows: [
		// A button in the UI, with the story's key as its form.
		userTrigger(develop),
		// A Jira webhook: labelling a story with the start label starts a run for it.
		jira.onIssueLabeled(develop, startLabel),
	],
})
