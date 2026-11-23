import { route, token } from '@rooted/router/routes'

/** The deployed apps, their workflows and what starts them. */
export const AppsRoute = route`/apps/`({
	async resolve({ create }) {
		const { AppsPage } = await import('./apps.mts')
		return create(AppsPage)
	},
})

/** Starts a workflow from its button: what the app still needs first, then its parameters. */
export const StartRoute = route`/${AppsRoute}/${token('app', String)}/start/${token('trigger', String)}/`({
	async resolve({ create, tokens }) {
		const { StartPage } = await import('./start.mts')
		return create(StartPage, {
			app: tokens.app,
			trigger: tokens.trigger,
		})
	},
})
