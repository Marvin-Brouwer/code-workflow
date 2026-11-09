import { realpathSync } from 'node:fs'
import path from 'node:path'
import { mailboxEnvironmentVariable } from '@mesh-flow/protocol'
import { callSite } from '../run/call-site.mts'
import { startFromEngine } from '../workflow/start-from-engine.mts'
import type { Trigger } from './trigger.mts'

/** What an entry file declares: everything that can start a run. */
export interface WorkflowEntry {
	readonly triggers: readonly Trigger[]
}

/**
 * The entry file's default export, `workflows/main.mts`: everything that can start a run, in one
 * place.
 *
 * ```ts
 * export default defineWorkflows(
 * 	userTrigger(fixIssue),
 * 	webhook(fixIssue, IssueLabeled.transform((event) => ({ issue: event.issue.number }))),
 * 	schedule(weeklyReport, '0 7 * * 1'),
 * )
 * ```
 *
 * Only the workflows listed here can be started by the UI, a webhook or a schedule. The CLI and
 * tests can still start any workflow the entry file's modules define.
 *
 * When the engine runs the entry file (`node workflows/main.mts` in the sandbox), it starts by
 * itself once the file is loaded, and does what the engine asked: describe what it declares, or
 * run one workflow. Anywhere else, such as in a test that imports the entry file, it only returns
 * the triggers.
 */
export function defineWorkflows(...triggers: Trigger[]): WorkflowEntry {
	const seen = new Set<string>()
	for (const trigger of triggers) {
		const key = `${trigger.kind} ${trigger.id}`
		if (seen.has(key)) throw new Error(`The entry file has the ${trigger.kind} trigger ${trigger.id} twice.${hintFor(trigger)}`)
		seen.add(key)
	}
	const entry: WorkflowEntry = Object.freeze({ triggers: Object.freeze([...triggers]) })
	if (isEntryOfEngineRun(callSite(1)?.file)) {
		// After the whole module has loaded, so everything the file defines is there.
		setImmediate(() => {
			void startFromEngine(entry)
		})
	}
	return entry
}

function hintFor(trigger: Trigger): string {
	if (trigger.kind === 'webhook') return ' Give the second one a name of its own: webhook(workflow, schema, { name }).'
	if (trigger.kind === 'schedule') return ' A workflow has one schedule per cron expression.'
	return ''
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
