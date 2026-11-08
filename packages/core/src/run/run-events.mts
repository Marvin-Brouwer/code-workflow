import { describeError } from './describe-error.mts'
import { currentScope, inScope, type Scope } from './run-scope.mts'

/** Fields of an event besides `id`, `parentId`, `type` and `at`. They must survive `JSON.stringify`. */
export type EventFields = Readonly<Record<string, unknown>>

/**
 * Sends one node of the run's event tree, as a child of the scope's current event, and returns its
 * id. The ids carry the run attempt, so a restarted run never reuses one.
 */
export function emitEvent(scope: Scope, type: string, fields: EventFields = {}): string {
	const id = `${scope.run.attempt}-${scope.run.count('event')}`
	const event = { ...fields, id, type, at: new Date().toISOString() }
	scope.run.channel.send({ type: 'event', event: scope.eventId === undefined ? event : { ...event, parentId: scope.eventId } })
	return id
}

/**
 * Runs `body` as a node of the event tree: one `type` event first, then `<type>-succeeded` or
 * `<type>-failed` under it. Events that `body` sends go under the node too.
 */
export async function inEvent<T>(type: string, fields: EventFields, body: (scope: Scope) => Promise<T>): Promise<T> {
	return inEventOf(currentScope(type), type, fields, body)
}

/** {@link inEvent} under a scope that isn't the current one, such as a loop's from inside a tool call. */
export async function inEventOf<T>(parent: Scope, type: string, fields: EventFields, body: (scope: Scope) => Promise<T>): Promise<T> {
	const scope: Scope = { ...parent, eventId: emitEvent(parent, type, fields) }
	try {
		const value = await inScope(scope, () => body(scope))
		emitEvent(scope, `${type}-succeeded`)
		return value
	} catch (error) {
		emitEvent(scope, `${type}-failed`, { error: describeError(error) })
		throw error
	}
}
