import { route, token } from '@rooted/router/routes'

/** Every run, those that need someone on top. */
export const RunsRoute = route`/runs/`({
	async resolve({ create }) {
		const { RunsPage } = await import('./runs.mts')
		return create(RunsPage)
	},
})

/** One run: where it is, what it waits on, and its steps as bars. */
export const RunRoute = route`/${RunsRoute}/${token('id', String)}/`({
	async resolve({ create, tokens }) {
		const { RunPage } = await import('./run.mts')
		return create(RunPage, {
			id: tokens.id,
		})
	},
})
