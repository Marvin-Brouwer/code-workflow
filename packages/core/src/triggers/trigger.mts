import type { SignatureScheme } from '@mesh-flow/protocol'
import type { z } from 'zod'
import type { AnyWorkflow } from '../workflow/workflow.mts'

/** A button in the UI that starts a workflow, with its parameters as the button's form. */
export interface UserTrigger {
	readonly kind: 'user'
	/** The workflow's name: one button per workflow. */
	readonly id: string
	readonly workflow: AnyWorkflow
}

/** Starts a workflow for each webhook delivery that fits a schema. */
export interface WebhookTrigger {
	readonly kind: 'webhook'
	/** The webhook's name, in its URL: the workflow's name unless it was given one. */
	readonly id: string
	readonly workflow: AnyWorkflow
	/** Turns a delivery's payload into the workflow's parameters. */
	readonly schema: z.ZodType
	/** How deliveries are signed, with header names in lowercase. */
	readonly signature: SignatureScheme
	/** The lowercase header whose value names a delivery, so a redelivery reuses its run. */
	readonly deliveryHeader?: string
}

/** Starts a workflow on the engine's wall clock, with fixed parameters. */
export interface ScheduleTrigger {
	readonly kind: 'schedule'
	/** The workflow's name and the cron expression. */
	readonly id: string
	readonly workflow: AnyWorkflow
	readonly cron: string
	readonly parameters: unknown
}

/** Something that can start a run, listed in the app's `defineMeshFlow`. */
export type Trigger = UserTrigger | WebhookTrigger | ScheduleTrigger
