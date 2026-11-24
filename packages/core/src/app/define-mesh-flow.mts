import { realpathSync } from 'node:fs'
import path from 'node:path'
import { mailboxEnvironmentVariable, type SandboxDescription } from '@mesh-flow/protocol'
import { callSite } from '../run/call-site.mts'
import { assertUniqueTriggers } from '../triggers/assert-unique-triggers.mts'
import type { WorkflowBundle } from '../triggers/define-workflows.mts'
import type { Trigger } from '../triggers/trigger.mts'
import { startFromEngine } from '../workflow/start-from-engine.mts'
import { madeProviders, type ModelProvider, type ModelProviderFactory } from './model-provider.mts'

/** What `defineMeshFlow` takes. */
export interface MeshFlowOptions {
	/** The sandbox every run gets, such as `image({ name: 'node:26-slim' })`. */
	readonly sandbox: SandboxDescription
	/**
	 * The model providers the app's agents may run on, in the order a model is looked up: the first
	 * one that offers it and has a key serves it. A factory such as `anthropicClaude` can be listed
	 * as it is, or called with a name or base URL of its own. Default: none, for an app without agents.
	 */
	readonly modelProviders?: readonly (ModelProvider | ModelProviderFactory)[]
	/** Everything that can start a run: triggers, and bundles of them from `defineWorkflows`. */
	readonly workflows: readonly (Trigger | WorkflowBundle)[]
}

/** A mesh-flow app: its sandbox, its model providers, and everything that can start a run. */
export interface MeshFlowApp {
	readonly sandbox: SandboxDescription
	readonly modelProviders: readonly ModelProvider[]
	readonly triggers: readonly Trigger[]
}

/**
 * The app's entry file's default export, the file `main` in `package.json` points at: the
 * sandbox its runs get, the model providers its agents run on, and everything that can start a
 * run, in one place.
 *
 * ```ts
 * import { npmRegistry } from '@mesh-flow/toolchain-node'
 *
 * export default defineMeshFlow({
 * 	sandbox: image({
 * 		name: 'node:26-slim',
 * 		registries: [npmRegistry],
 * 	}),
 * 	modelProviders: [
 * 		anthropicClaude,
 * 		openRouter({
 * 			name: 'team-openrouter',
 * 			baseUrl: 'https://llm-proxy.example.com/api/v1',
 * 		}),
 * 	],
 * 	workflows: [
 * 		// A button in the UI, with the issue as its form.
 * 		userTrigger(fixIssue),
 * 		webhook(fixIssue, IssueLabeled.transform((event) => ({ issue: event.issue.number }))),
 * 		schedule(weeklyReport, 'weekly'),
 * 	],
 * })
 * ```
 *
 * Only the workflows listed here can be started by the UI, a webhook or a schedule. The CLI and
 * tests can still start any workflow the app's modules define.
 *
 * When the engine runs the built app (`node main.mjs` in the sandbox, or `mesh-flow build` on your
 * machine), it starts by itself once the file is loaded, and does what it was asked: describe the
 * app, or run one workflow. Anywhere else, such as in a test that imports the entry file, it only
 * returns the app.
 */
export function defineMeshFlow(options: MeshFlowOptions): MeshFlowApp {
	const triggers = options.workflows.flatMap((listed) => ('kind' in listed ? [listed] : listed.triggers))
	assertUniqueTriggers(triggers)
	const modelProviders = madeProviders(options.modelProviders ?? [])
	assertUniqueProviders(modelProviders)
	const app: MeshFlowApp = Object.freeze({
		sandbox: options.sandbox,
		modelProviders: Object.freeze(modelProviders),
		triggers: Object.freeze(triggers),
	})
	if (isEntryOfEngineRun(callSite(1)?.file)) {
		// After the whole module has loaded, so everything the file defines is there.
		setImmediate(() => {
			void startFromEngine(app)
		})
	}
	return app
}

/** Throws when two providers have the same name: a key is set per name. */
function assertUniqueProviders(providers: readonly ModelProvider[]): void {
	const seen = new Set<string>()
	for (const { name } of providers) {
		if (seen.has(name))
			throw new Error(
				`The model provider ${name} is listed twice. Give the second one a name of its own, such as openRouter({ name: 'team-openrouter' }).`,
			)
		seen.add(name)
	}
}

/** Whether `file` is the file the engine started this process with. */
function isEntryOfEngineRun(file: string | undefined): boolean {
	const entry = process.argv[1]
	if (process.env[mailboxEnvironmentVariable] === undefined || file === undefined || entry === undefined) return false
	// Node loads the entry by its real path, which can differ from argv: a symlink, or a Windows short name.
	return realPath(entry) === realPath(file)
}

function realPath(file: string): string {
	try {
		return realpathSync.native(path.resolve(file))
	} catch {
		return path.resolve(file)
	}
}
