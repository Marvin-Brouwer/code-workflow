import { realpathSync } from 'node:fs'
import path from 'node:path'
import { mailboxEnvironmentVariable } from '@mesh-flow/protocol'
import { callSite } from '../run/call-site.mts'
import { startFromEngine } from './start-from-engine.mts'

/** A workflow: a name and a body of plain async code. */
export interface Workflow {
	/** Identifies the workflow's runs. */
	readonly name: string
	readonly body: () => Promise<void>
}

/** Workflow names: they go into run ids, loop keys and file names. */
const workflowNamePattern = /^[a-z0-9][a-z0-9-]*$/

/**
 * Defines a workflow. The body is ordinary async code: `await`, `if`, `for`, `Promise.all` and
 * `throw` are the control flow, and agents are calls inside it.
 *
 * ```ts
 * export default workflow('develop', async () => {
 * 	const { key } = await input('Which story should be developed?', { key: jira.key })
 * 	const story = await jira.collect(key)
 * 	const plan = await planner.loop`Plan ${story}, then propose it with ${propose(Plan)}.`
 * 	// ...
 * })
 * ```
 *
 * When the engine runs the file that defines it (`node workflows/develop.mts` in the sandbox), the
 * workflow starts by itself once the file is loaded. Anywhere else, run it with `runWorkflow`.
 */
export function workflow(name: string, body: () => Promise<void>): Workflow {
	if (!workflowNamePattern.test(name)) throw new Error(`Workflow name ${name}: use lowercase letters, digits and dashes.`)
	const definition: Workflow = Object.freeze({ name, body })
	if (isEntryOfEngineRun(callSite(1)?.file)) {
		// After the whole module has loaded, so the body can use everything the file defines.
		setImmediate(() => {
			void startFromEngine(definition)
		})
	}
	return definition
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
