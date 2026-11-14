import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai'
import { createModels, type Models } from '@earendil-works/pi-ai/models'
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseFactory,
	type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'

/** The model id agents use for the scripted model. */
export const modelId = 'scripted-model'

/** A model for tests that answers from a script, one step per model turn, and keeps what it was sent. */
export function scriptedModel(steps: readonly FauxResponseStep[]): {
	readonly models: Models
	readonly requests: readonly TranscriptContext[]
} {
	const faux = fauxProvider({ provider: 'scripted', models: [{ id: modelId, reasoning: true }] })
	const requests: TranscriptContext[] = []
	faux.setResponses(
		steps.map((step) => (context, options, state, model) => {
			requests.push(context)
			return typeof step === 'function' ? step(context, options, state, model) : step
		}),
	)
	const models = createModels()
	models.setProvider(faux.provider)
	return { models, requests }
}

/** A turn that calls one tool. */
export function callsTool(name: string, args: Parameters<typeof fauxToolCall>[1] = {}): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
}

/** A turn that never comes, until the request is aborted. */
export const neverAnswers: FauxResponseFactory = (_context, options) =>
	new Promise((_resolve, reject) => {
		options?.signal?.addEventListener('abort', () => {
			reject(new Error('aborted'))
		})
	})

/** All text the model was sent in a request, for asserting on prompts. */
export function textOf(request: TranscriptContext | undefined): string {
	return JSON.stringify(request?.messages ?? [])
}
