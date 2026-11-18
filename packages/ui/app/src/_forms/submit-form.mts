import type { TargetedEvent } from '@rooted/components/events'
import type { Answer } from '../_shared/api.mts'

/** What submitting a form does: send it, and say what went wrong in `status` when that fails. */
export interface SubmitOptions {
	/** Where a refusal is shown. Emptied on the next try. */
	readonly status: HTMLElement
	readonly abortSignal: AbortSignal
	/** Sends what the form holds. A refusal is an answer, shown in `status`. */
	readonly send: (form: FormData, abortSignal: AbortSignal) => Promise<Answer<unknown>>
	/** Called after it was sent, such as to show the change. */
	readonly done?: () => void
}

/**
 * A form's `submit` handler: it sends the form instead of loading a page, with its buttons off while
 * it's under way, and shows a refusal in `status`.
 *
 * ```ts
 * element('form', {
 * 	children: [input, button, status],
 * 	on: {
 * 		submit: submitForm({ status, abortSignal: signal, send, done }),
 * 	},
 * })
 * ```
 */
export function submitForm({ status, abortSignal, send, done }: SubmitOptions) {
	return async (event: TargetedEvent<SubmitEvent, HTMLFormElement>): Promise<void> => {
		event.preventDefault()
		const form = event.currentTarget
		const buttons = [...form.querySelectorAll('button')]
		status.textContent = ''
		for (const button of buttons) button.disabled = true
		const answer = await send(new FormData(form), abortSignal)
		for (const button of buttons) button.disabled = false
		if (abortSignal.aborted) return
		if (!answer.ok) {
			status.textContent = answer.error
			return
		}
		form.reset()
		done?.()
	}
}
