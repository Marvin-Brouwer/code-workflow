import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tool, workspace, type Tool, type ToolContext, type WorkspaceFile } from '@mesh-flow/core'
import { z } from 'zod'

/** The file in the workspace the deviations are recorded in, next to the plan. */
const deviationsFile = workspace.file('plan-deviations.md')

/** What a new deviations file starts with. */
const fileHeading = '# Deviations from the plan\n\n'

/** One deviation, as an agent records it. */
const Deviation = z.object({
	repository: z.string().min(1).describe('The repository it applies to'),
	reason: z.string().min(1).describe('What was found, and where: a review comment, a pipeline, the implementation'),
	change: z.string().min(1).describe('How the work now deviates from the plan'),
})
export type Deviation = z.infer<typeof Deviation>

/** Where `deviations.record` put a deviation. */
export interface RecordedDeviation {
	readonly recordedIn: string
}

/** The deviations file, with the tool that adds one. */
export interface Deviations extends WorkspaceFile {
	readonly record: Tool<Deviation, RecordedDeviation>
}

/** What a deviation looks like in the file. */
function entryOf(deviation: Deviation): string {
	return `## ${deviation.repository}\n\n- Found: ${deviation.reason}\n- Deviation: ${deviation.change}\n\n`
}

/** Whether a file system error says the file is there already. */
function alreadyExists(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/**
 * The latest record. The next one waits for it, so the heading and the check for a repeat hold
 * while parts record side by side. A caller that stops isn't held up by the wait: a tool's call
 * settles on its signal.
 */
let lastRecord: Promise<unknown> = Promise.resolve()

/** Records a deviation once the records before it are done. */
async function record(deviation: Deviation, context: ToolContext): Promise<RecordedDeviation> {
	const turn = lastRecord.catch(() => undefined).then(() => recordNow(deviation, context))
	lastRecord = turn
	return turn
}

/**
 * Adds one deviation to the file, which starts with a heading when it's new. One that is in the
 * file already, as when a loop that recorded it runs again, is left at that.
 */
async function recordNow(deviation: Deviation, { abortSignal }: ToolContext): Promise<RecordedDeviation> {
	abortSignal.throwIfAborted()
	const file = deviationsFile.location()
	await mkdir(path.dirname(file), { recursive: true })
	await writeFile(file, fileHeading, { flag: 'wx' }).catch((error: unknown) => {
		if (!alreadyExists(error)) throw error
	})
	const entry = entryOf(deviation)
	if ((await readFile(file, { encoding: 'utf8', signal: abortSignal })).includes(entry)) return { recordedIn: file }
	abortSignal.throwIfAborted()
	await appendFile(file, entry)
	return { recordedIn: file }
}

/**
 * Deviations from the plan: the approved plan stays as it was approved, and what later turns out
 * different is recorded next to it, in `plan-deviations.md` in the workspace. In a prompt it
 * renders as that file's absolute path; `deviations.record` is the tool that adds one, in Markdown.
 *
 * The file can be read and written like any workspace file, and `deviations.record` is a function
 * for code too: a deviation that code finds, such as a repository the plan didn't list, is recorded
 * the same way. Recording the same deviation again, as when a loop runs again, adds nothing.
 * Deviations recorded side by side, by parts delivered at once, are written one after the other.
 *
 * `deviations.record` is the tool. Input: `{ repository, reason, change }`. `repository` is the
 * repository it applies to, `reason` is what was found and where, and `change` is how the work now
 * deviates from the plan. The result is `{ recordedIn }`, the file's absolute path.
 *
 * @throws From the tool: when the file can't be written; and, with the stop's reason, when the run
 * stops.
 *
 * @example From code
 * ```ts
 * await deviations.record({
 * 	repository: part.repository,
 * 	reason: 'The pipeline needs .NET 10, which the plan assumed was there already',
 * 	change: 'global.json pins the SDK first',
 * })
 * await jira.comment(story, await deviations.read(), { key: 'deviations' })
 * ```
 *
 * @example For an agent
 * ```ts
 * await developer.loop`
 * 	Implement ${plan.path}, as amended by ${deviations}. Record any deviation with ${deviations.record}.
 * `
 * ```
 */
export const deviations: Deviations = Object.freeze({
	...deviationsFile,
	record: tool('recordDeviation', {
		description: 'Records how the work deviates from the approved plan, and why, next to the plan',
		input: Deviation,
		action: record,
	}),
})
