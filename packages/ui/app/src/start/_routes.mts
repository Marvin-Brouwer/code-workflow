import { route, token } from '@rooted/router/routes'

/** A new run: which of the app's buttons, when it has more than one. */
export const NewRunRoute = route`/start/`({
	async resolve({ create }) {
		const { NewRunPage } = await import('./new-run.mts')
		return create(NewRunPage)
	},
})

/** Starts a workflow from its button: what the app still needs first, then its parameters. */
export const StartRoute = route`/${NewRunRoute}/${token('trigger', String)}/`({
	async resolve({ create, tokens }) {
		const { StartPage } = await import('./start.mts')
		return create(StartPage, {
			trigger: tokens.trigger,
		})
	},
})

/** What the app still needs before a run can start, each with the form that sets it. */
export const SetupRoute = route`/setup/`({
	async resolve({ create }) {
		const { SetupPage } = await import('./setup.mts')
		return create(SetupPage)
	},
})
