/**
 * Exit tools: gates on "may this agent finish?". An agent's result only comes through these.
 */
import type { z } from 'zod'
import type { Check } from './check'
import type { WorkspaceFolder } from './workspace'

export interface Exit<T> {
	readonly kind: 'exit'
	readonly result?: T
}

/** Finishes with data matching the schema. Invalid data is returned to the agent as an error. */
export function succeed(): Exit<void>
export function succeed<T extends z.ZodTypeAny>(schema: T): Exit<z.infer<T>>
export function succeed(folder: WorkspaceFolder): Exit<WorkspaceFolder>

/** Finishes only after a human approves. A rejection returns the feedback to the agent. */
export function propose<T extends z.ZodTypeAny>(schema: T): Exit<z.infer<T>>

/**
 * Finishes only when every check passes. The checks run concurrently when the agent hands in;
 * findings are returned to the agent. After `maxRejections` (default 5) the loop fails.
 */
export function verify(...checks: readonly Check[]): Exit<void>
export function verify(options: { maxRejections: number }, ...checks: readonly Check[]): Exit<void>

/** The agent gives up, with a reason. `loop` rejects with it. */
export const fail: Exit<never>
