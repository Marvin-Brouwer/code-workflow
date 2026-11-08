import { findingLines, type Finding } from '../check/check.mts'

/** The agent called `fail`. */
export class AgentGaveUp extends Error {
	override readonly name = 'AgentGaveUp'
	readonly reason: string

	constructor(reason: string) {
		super(`The agent gave up: ${reason}`)
		this.reason = reason
	}
}

/** The loop went over its `limit`. */
export class LoopLimitExceeded extends Error {
	override readonly name = 'LoopLimitExceeded'
	readonly limit: 'turns' | 'minutes'
	readonly allowed: number

	constructor(limit: 'turns' | 'minutes', allowed: number) {
		super(`The loop went over its limit of ${allowed} ${limit}.`)
		this.limit = limit
		this.allowed = allowed
	}
}

/** `verify` rejected the agent's work `maxRejections` times. */
export class ChecksFailed extends Error {
	override readonly name = 'ChecksFailed'
	readonly findings: readonly Finding[]

	constructor(rejections: number, findings: readonly Finding[]) {
		super(`The checks rejected the work ${rejections} times. Last findings:\n${findingLines(findings)}`)
		this.findings = findings
	}
}

/** The agent kept stopping without calling an exit, also after being reminded. */
export class ExitNotCalled extends Error {
	override readonly name = 'ExitNotCalled'

	constructor(exits: readonly string[], reminders: number) {
		super(`The agent stopped without calling ${exits.join(' or ')}, also after ${reminders} reminders.`)
	}
}

/** The agent's run ended without an answer: a model error, a missing model, the context limit. */
export class LoopFailed extends Error {
	override readonly name = 'LoopFailed'
	readonly reason: string

	constructor(reason: string, detail: unknown) {
		super(
			detail === undefined
				? `The agent's run ended without an answer: ${reason}.`
				: `The agent's run ended without an answer: ${reason}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
		)
		this.reason = reason
	}
}
