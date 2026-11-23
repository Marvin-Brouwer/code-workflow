import type { Answer } from '../_shared/api.mts'
import type { RunRecord } from '../_shared/runs.mts'

/**
 * Statuses with which the engine refuses an answer to a question it no longer asks, or that is
 * being answered: someone else, in another tab or with the CLI, answered it first.
 */
const answeredElsewhere: ReadonlySet<number> = new Set([404, 409])

/** `answer`, saying so plainly when the question was answered elsewhere first. */
export function shownAnswer(answer: Answer<RunRecord>): Answer<RunRecord> {
	if (answer.ok || answer.status === undefined || !answeredElsewhere.has(answer.status)) return answer
	return { ok: false, error: 'This was answered elsewhere, in another tab or with the CLI.', status: answer.status }
}
