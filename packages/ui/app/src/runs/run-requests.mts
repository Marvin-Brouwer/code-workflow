import { component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { z } from 'zod'
import { SchemaForm } from '../_forms/schema-form.mts'
import { read, send } from '../_shared/api.mts'
import { poll } from '../_shared/poll.mts'
import { answerSchemaOf, RunRecord, type RunRequest } from '../_shared/runs.mts'
import { SignInState } from '../_shared/settings.mts'
import { ConnectorsRoute } from '../settings/_routes.mts'
import { shownTime } from './run-labels.mts'
import styles from './run-requests.css'

export interface RunRequestOptions {
	readonly run: string
	readonly request: RunRequest
}

/**
 * What a run waits on, and what answers it: a form for a question, where to sign in for a sign-in,
 * and the time for a wait, which the engine answers itself.
 */
export const RunRequestView = component<RunRequestOptions>({
	name: 'run-request',
	styles,
	onMount({ append, element, create, options, signal }) {
		const { run, request } = options
		if (request.kind === 'wake') {
			append(element('p', { textContent: `Waits until ${shownTime(request.at)}.` }))
			return
		}
		if (request.kind === 'input') {
			append(
				element('p', { classes: styles.question, textContent: request.question }),
				create(SchemaForm, {
					schema: answerSchemaOf(request),
					submitLabel: 'Answer',
					send: (value, abortSignal) =>
						send(
							'POST',
							`/engine/runs/${encodeURIComponent(run)}/answers/${encodeURIComponent(request.id)}`,
							{ value },
							RunRecord,
							abortSignal,
						),
				}),
			)
			return
		}
		const where = element('p', { textContent: 'Waiting for the service to hand out a code.' })
		append(
			element('p', {
				children: [
					`Sign in to ${request.connector}. The run goes on once you did. `,
					create(Link, { href: href.for(ConnectorsRoute), children: 'All sign-ins' }),
				],
			}),
			where,
		)
		// Sign-ins aren't in the change stream: look while this waits.
		poll(async (abortSignal) => {
			const signIns = await read('/engine/sign-ins', z.array(SignInState), abortSignal)
			const state = signIns.ok ? signIns.value.find(({ connector }) => connector === request.connector) : undefined
			if (state?.prompt === undefined) return
			where.replaceChildren(
				'Open ',
				element('a', { href: state.prompt.url, target: '_blank', rel: 'noreferrer', textContent: state.prompt.url }),
				' and enter ',
				element('code', { textContent: state.prompt.code }),
				`, before ${shownTime(state.prompt.expiresAt)}.`,
			)
		}, signal)
	},
})
