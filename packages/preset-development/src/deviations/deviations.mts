import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tool, workspace, type Tool, type ToolContext, type WorkspaceFile } from '@mesh-flow/core'
import { z } from 'zod'

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
