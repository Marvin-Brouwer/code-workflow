/**
 * The entry file, which `main` in package.json names: the sandbox the app's runs get, and
 * everything that can start a run of its workflows. A workflow says what it does and what it
 * starts with; this file says how it gets started and where it runs.
 *
 * `mesh-flow build` bundles this file with its dependencies and writes down what it declares, so
 * the engine only runs `node` in the sandbox.
 *
 * Once the atlassian connector ships its event schemas, a Jira webhook (a story labelled for
 * development) goes here as `webhook(develop, ...)`, next to the button.
 */
import { defineMeshFlow, image, userTrigger } from '@mesh-flow/core'
import { develop } from './workflows/develop.mts'

export default defineMeshFlow({
	sandbox: image({ name: 'node:22-slim', memoryMb: 4096, egress: ['registry.npmjs.org'] }),
	workflows: [
		// A button in the UI, with the story's key as its form.
		userTrigger(develop),
	],
})
