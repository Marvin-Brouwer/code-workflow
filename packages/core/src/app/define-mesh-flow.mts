import { realpathSync } from 'node:fs'
import path from 'node:path'
import { mailboxEnvironmentVariable, type SandboxDescription } from '@mesh-flow/protocol'
import { callSite } from '../run/call-site.mts'
import { assertUniqueTriggers } from '../triggers/assert-unique-triggers.mts'
import type { WorkflowBundle } from '../triggers/define-workflows.mts'
import type { Trigger } from '../triggers/trigger.mts'
import { startFromEngine } from '../workflow/start-from-engine.mts'

/** What `defineMeshFlow` takes. */
export interface MeshFlowOptions {
	/** The sandbox every run gets, such as `image({ name: 'node:26-slim' })`. */
	readonly sandbox: SandboxDescription
	/** Everything that can start a run: triggers, and bundles of them from `defineWorkflows`. */
	readonly workflows: readonly (Trigger | WorkflowBundle)[]
}

/** A mesh-flow app: its sandbox, and everything that can start a run. */
export interface MeshFlowApp {
	readonly sandbox: SandboxDescription
	readonly triggers: readonly Trigger[]
}

/**
 * The app's entry file's default export, the file `main` in `package.json` points at: the
 * sandbox its runs get, and everything that can start a run, in one place.
 *
 * ```ts
 * export default defineMeshFlow({
 * 	sandbox: image({ name: 'node:26-slim', egress: ['api.example.com'] }),
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
	const app: MeshFlowApp = Object.freeze({ sandbox: options.sandbox, triggers: Object.freeze(triggers) })
	if (isEntryOfEngineRun(callSite(1)?.file)) {
		// After the whole module has loaded, so everything the file defines is there.
		setImmediate(() => {
			void startFromEngine(app)
		})
	}
	return app
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
