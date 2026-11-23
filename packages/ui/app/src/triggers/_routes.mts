import { route } from '@rooted/router/routes'

/** The app's triggers: what starts its workflows. */
export const TriggersRoute = route`/triggers/`({
	async resolve({ create }) {
		const { TriggersPage } = await import('./triggers.mts')
		return create(TriggersPage)
	},
})
