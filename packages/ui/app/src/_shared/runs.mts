/**
 * The runs and apps as the engine routes answer them, as far as the page reads them. Loose, so a
 * field the engine adds later doesn't break the page; the page can't import the engine's own
 * schemas, which come with Node packages.
 *
 * @module
 */
import { z } from 'zod'

/** What a run waits on that a person or the engine answers. */
export const RunRequest = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('input'), id: z.string(), question: z.string(), fields: z.record(z.string(), z.unknown()) }),
	z.object({ kind: z.literal('wake'), id: z.string(), at: z.string() }),
	z.object({ kind: z.literal('login'), id: z.string(), connector: z.string() }),
])
export type RunRequest = z.infer<typeof RunRequest>

/** Where a run is, as `RunStatus` in `@mesh-flow/engine` says. */
export const RunStatus = z.enum(['starting', 'running', 'paused', 'restartable', 'succeeded', 'failed', 'stopped', 'skipped'])
export type RunStatus = z.infer<typeof RunStatus>

/** What a run used of one model. */
export const ModelUsage = z.looseObject({
	requests: z.number(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	cacheWriteTokens: z.number(),
	costUsd: z.number(),
})

/** A run as the engine keeps it, as far as the page reads it. */
export const RunRecord = z.looseObject({
	id: z.string(),
	workflow: z.string(),
	trigger: z.object({ kind: z.string(), id: z.string() }),
	app: z.looseObject({ name: z.string(), version: z.string() }),
	status: RunStatus,
	pending: z.array(RunRequest),
	error: z.string().optional(),
	reason: z.string().optional(),
	usage: z.record(z.string(), ModelUsage).optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
})
export type RunRecord = z.infer<typeof RunRecord>

/** One node of a run's event tree: its own fields besides these depend on its type. */
export const RunEvent = z.looseObject({ id: z.string(), parentId: z.string().optional(), type: z.string(), at: z.string() })
export type RunEvent = z.infer<typeof RunEvent>

/** A workflow an app defines, with its parameters as JSON Schema. */
export const WorkflowDescription = z.object({ name: z.string(), parameters: z.record(z.string(), z.unknown()) })

/** What can start a workflow of an app. */
export const TriggerDescription = z.discriminatedUnion('kind', [
	z.looseObject({ kind: z.literal('user'), id: z.string(), workflow: z.string() }),
	z.looseObject({ kind: z.literal('webhook'), id: z.string(), workflow: z.string() }),
	z.looseObject({ kind: z.literal('schedule'), id: z.string(), workflow: z.string(), cron: z.string() }),
])
export type TriggerDescription = z.infer<typeof TriggerDescription>

/** A deployed app: its current version and what it declares. */
export const DeployedApp = z.object({
	name: z.string(),
	version: z.string(),
	manifest: z.looseObject({
		builtAt: z.string(),
		description: z.looseObject({ workflows: z.array(WorkflowDescription), triggers: z.array(TriggerDescription) }),
	}),
})
export type DeployedApp = z.infer<typeof DeployedApp>

/** The answer schema of an input request: its fields, each one required. */
export function answerSchemaOf(request: Extract<RunRequest, { kind: 'input' }>): Record<string, unknown> {
	return { type: 'object', properties: request.fields, required: Object.keys(request.fields) }
}
