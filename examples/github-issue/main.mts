/**
 * The entry file, which `main` in package.json names: the sandbox the app's runs get, the model
 * providers its agents run on, and everything that can start a run. A workflow says what it does and what it starts with; this
 * file says how it gets started and where it runs.
 *
 * The sandbox needs git next to node, which `node:26-bookworm` has. It reaches the npm registry,
 * so the checkout's npm dependencies install and the agent can run the tests, and nothing else:
 * GitHub is only spoken to from the host, through the gateway.
 */
import { anthropicClaude, defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
import { github } from '@mesh-flow/github/hooks'
import { npmRegistry } from '@mesh-flow/toolchain-node'
import { fixIssue } from './workflows/fix-issue.mts'

export default defineMeshFlow({
	sandbox: image({
		name: 'node:26-bookworm',
		registries: [npmRegistry],
	}),
	// The agents run on Anthropic. Each user sets its key: `mesh-flow provider key anthropic`.
	modelProviders: [anthropicClaude],
	workflows: [
		// A button in the UI, with the issue as its form.
		userTrigger(fixIssue),
		// A GitHub webhook: labelling an issue `ai-fix` starts a run for it.
		github.onIssueLabeled(fixIssue, 'ai-fix'),
	],
})
