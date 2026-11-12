import { createModels, type Models } from '@earendil-works/pi-ai/models'
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxResponseFactory,
	type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage, TranscriptContext as Context } from '@earendil-works/pi-ai'

/** A model for tests that answers from a script, one step per model turn. */
export interface ScriptedModel {
	readonly models: Models
	/** The model id agents use for it. */
	readonly id: string
	/** How many requests the model got. */
	readonly calls: () => number
	/** What the model was sent, per request. */
	readonly requests: readonly Context[]
}

export const modelId = 'scripted-model'

export function scriptedModel(steps: readonly FauxResponseStep[]): ScriptedModel {
	const faux = fauxProvider({ provider: 'scripted', models: [{ id: modelId, reasoning: true }] })
	const requests: Context[] = []
	faux.setResponses(
		steps.map((step) => (context, options, state, model) => {
			requests.push(context)
			return typeof step === 'function' ? step(context, options, state, model) : step
		}),
	)
	const models = createModels()
	models.setProvider(faux.provider)
	return { models, id: modelId, calls: () => faux.state.callCount, requests }
}

/** A turn that calls one tool. */
export function callsTool(name: string, args: Parameters<typeof fauxToolCall>[1] = {}): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
}

/** A turn that answers with text. */
export function says(text: string): AssistantMessage {
	return fauxAssistantMessage([fauxText(text)])
}

/** A turn that comes after `ms`. */
export function slowly(ms: number, message: AssistantMessage): FauxResponseStep {
	return () =>
		new Promise((resolve) => {
			setTimeout(resolve, ms, message)
		})
}

/** A turn that never comes, until the request is aborted. */
export const neverAnswers: FauxResponseFactory = (_context, options) =>
	new Promise((_resolve, reject) => {
		options?.signal?.addEventListener('abort', () => {
			reject(new Error('aborted'))
		})
	})

/** `text` as it appears in what `textOf` returns, which is JSON: quotes and backslashes escaped. */
export function asInRequest(text: string): string {
	const quoted = JSON.stringify(text)
	return quoted.slice('"'.length, -'"'.length)
}

/** All text the model was sent in a request, for asserting on prompts. */
export function textOf(request: Context | undefined): string {
	return JSON.stringify(request?.messages ?? [])
}
