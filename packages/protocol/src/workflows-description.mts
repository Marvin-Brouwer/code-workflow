import { z } from 'zod'
import { ToolName } from './gateway-call.mts'

/** A JSON Schema, as a plain object. */
export const JsonSchema = z.record(z.string(), z.unknown())
export type JsonSchema = z.infer<typeof JsonSchema>

/** What can start a run: a button in the UI, a webhook delivery or a schedule. */
export const TriggerKind = z.enum(['user', 'webhook', 'schedule'])
export type TriggerKind = z.infer<typeof TriggerKind>

/**
 * How a webhook delivery is signed, checked by the engine before anything else:
 *
 * - `secret-header`: the secret itself in a header, as GitLab sends it (`x-gitlab-token`);
 * - `hmac-sha256`: the hex HMAC-SHA256 of the raw body with the secret, in a header after
 *   `prefix`, as GitHub sends it (`x-hub-signature-256`, `sha256=`) and most others.
 */
export const SignatureScheme = z.discriminatedUnion('scheme', [
	z.object({ scheme: z.literal('secret-header'), header: z.string().min(1) }),
	z.object({ scheme: z.literal('hmac-sha256'), header: z.string().min(1), prefix: z.string() }),
])
export type SignatureScheme = z.infer<typeof SignatureScheme>

/** A workflow the entry file's modules define, with its parameters as JSON Schema (their input side). */
export const WorkflowDescription = z.object({ name: z.string().min(1), parameters: JsonSchema })
export type WorkflowDescription = z.infer<typeof WorkflowDescription>

/** One trigger of the entry file. Its `id` is unique per kind. */
export const TriggerDescription = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('user'), id: z.string().min(1), workflow: z.string().min(1) }),
	z.object({
		kind: z.literal('webhook'),
		id: z.string().min(1),
		workflow: z.string().min(1),
		/** The input side of the trigger's schema: what the engine checks a payload against. */
		payload: JsonSchema,
		signature: SignatureScheme,
		/** The header that names a delivery. Without it, a delivery is named by a hash of its body. */
		deliveryHeader: z.string().min(1).optional(),
	}),
	z.object({
		kind: z.literal('schedule'),
		id: z.string().min(1),
		workflow: z.string().min(1),
		cron: z.string().min(1),
		/** The fixed parameters, for showing. The run takes them from the entry file itself. */
		parameters: z.unknown().optional(),
	}),
])
export type TriggerDescription = z.infer<typeof TriggerDescription>

/**
 * The sandbox every run of the app gets: an OCI image, its resources, and the only hosts it may
 * reach over HTTPS. The engine checks it again against what its backends take.
 */
export const SandboxDescription = z.object({
	image: z.string().min(1),
	cpus: z.int().positive(),
	memoryMb: z.int().positive(),
	egress: z.object({ allow: z.array(z.string().min(1)).readonly() }),
})
export type SandboxDescription = z.infer<typeof SandboxDescription>

/**
 * What an entry file declares: its sandbox, every workflow its modules define, what can start them,
 * and the host tools its modules call through the gateway. A run's gateway takes only those.
 */
export const WorkflowsDescription = z.object({
	sandbox: SandboxDescription,
	workflows: z.array(WorkflowDescription),
	triggers: z.array(TriggerDescription),
	/** Apps built before the gateway list none. */
	tools: z.array(ToolName).default([]),
	/** The model ids of the app's agents, which a trigger checks against the providers before it starts a run. */
	models: z.array(z.string().min(1)).default([]),
})
export type WorkflowsDescription = z.infer<typeof WorkflowsDescription>
