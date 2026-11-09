import type { SignatureScheme } from '@mesh-flow/protocol'
import type { z } from 'zod'
import { WorkflowName, type Workflow } from '../workflow/workflow.mts'
import type { WebhookTrigger } from './trigger.mts'

/**
 * How a delivery is signed, as data the engine checks on the host:
 *
 * - `{ scheme: 'secret-header', header? }`: the secret itself in a header, as GitLab sends it.
 *   The header is `x-webhook-secret` unless you name another, such as `x-gitlab-token`;
 * - `{ scheme: 'hmac-sha256', header, prefix? }`: the hex HMAC-SHA256 of the body in a header,
 *   as GitHub (`x-hub-signature-256`, prefix `sha256=`) and most others send it.
 */
export type WebhookSignature =
	| { readonly scheme: 'secret-header'; readonly header?: string }
	| { readonly scheme: 'hmac-sha256'; readonly header: string; readonly prefix?: string }

/** Options of `webhook`. */
export interface WebhookOptions {
	/** The webhook's name in its URL. Default: the workflow's name. Two webhooks of one workflow need one. */
	readonly name?: string
	/** How deliveries are signed. Default: the secret in the `x-webhook-secret` header. */
	readonly signature?: WebhookSignature
	/**
	 * The header that names a delivery, such as `x-github-delivery`. A redelivery with the same
	 * name reuses the run it started. Without one, a delivery is named by a hash of its body.
	 */
	readonly deliveryHeader?: string
}

/** The header a secret goes in when the webhook names none. */
export const defaultSecretHeader = 'x-webhook-secret'

/**
 * Starts `workflow` for each webhook delivery that fits `schema`. The schema's output has to be the
 * workflow's parameters, so a mapping is a `.transform` on it:
 *
 * ```ts
 * const IssueLabeled = z.object({
 * 	action: z.literal('labeled'),
 * 	label: z.object({ name: z.literal('ai-fix') }),
 * 	issue: z.object({ number: z.number() }),
 * })
 *
 * export const triggers = defineWorkflows(
 * 	webhook(fixIssue, IssueLabeled.transform((event) => ({ issue: event.issue.number })), {
 * 		signature: { scheme: 'hmac-sha256', header: 'x-hub-signature-256', prefix: 'sha256=' },
 * 		deliveryHeader: 'x-github-delivery',
 * 	}),
 * )
 * ```
 *
 * The engine checks the signature and the structure of the payload (the schema's input side, as
 * JSON Schema) before it creates a sandbox, so put filters in the structure where they can go, as
 * literals and enums. `.refine` and `.transform` are code: they run in the sandbox when the run
 * starts, and a payload they reject ends the run as skipped.
 */
export function webhook<Shape extends z.ZodRawShape>(
	workflow: Workflow<Shape>,
	schema: z.ZodType<z.input<z.ZodObject<Shape>>>,
	options: WebhookOptions = {},
): WebhookTrigger {
	const id = options.name ?? workflow.name
	if (!WorkflowName.safeParse(id).success) throw new Error(`Webhook name ${id}: use lowercase letters, digits and dashes.`)
	return Object.freeze({
		kind: 'webhook',
		id,
		workflow,
		schema,
		signature: signatureScheme(options.signature),
		...(options.deliveryHeader === undefined ? {} : { deliveryHeader: options.deliveryHeader.toLowerCase() }),
	})
}

/** The scheme with its defaults filled in, and header names in lowercase, as the engine reads them. */
function signatureScheme(signature: WebhookSignature = { scheme: 'secret-header' }): SignatureScheme {
	if (signature.scheme === 'secret-header')
		return { scheme: 'secret-header', header: (signature.header ?? defaultSecretHeader).toLowerCase() }
	return { scheme: 'hmac-sha256', header: signature.header.toLowerCase(), prefix: signature.prefix ?? '' }
}
