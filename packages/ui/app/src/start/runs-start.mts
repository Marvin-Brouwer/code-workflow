import { choice, component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { z } from 'zod'
import { read } from '../_shared/api.mts'
import { onChange } from '../_shared/live-events.mts'
import { refresher } from '../_shared/refresher.mts'
import type { DeployedApp } from '../_shared/runs.mts'
import { MissingSetting } from '../_shared/settings.mts'
import { missingPath, readTheApp } from '../_shared/the-app.mts'
import { NewRunRoute, SetupRoute, StartRoute } from './_routes.mts'
import styles from './runs-start.css'
import { userTriggersOf } from './user-triggers.mts'

/**
 * Above the runs: a bar when the app still needs settings before a run can start, and a link to
 * start a new run when the app has a trigger a person starts. Nothing while the engine is down.
 */
export const RunsStart = component({
	name: 'runs-start',
	styles,
	onMount({ append, element, create, signal }) {
		const missingSlot = append(element('div'))
		const newRunSlot = append(element('div'))

		const missingBar = (count: number) =>
			element('p', {
				classes: styles.bar,
				role: 'status',
				children: [
					`The app still needs ${count} ${choice(count === 1, 'setting', 'settings')} before a run can start. `,
					create(Link, {
						href: href.for(SetupRoute),
						children: 'Set them up',
					}),
				],
			})

		const showNewRun = (app: DeployedApp | undefined) => {
			const [only, ...others] = userTriggersOf(app)
			if (only === undefined) {
				newRunSlot.replaceChildren()
				return
			}
			newRunSlot.replaceChildren(
				element('p', {
					children: create(Link, {
						href: choice(others.length === 0, href.for(StartRoute, { trigger: only.id }), href.for(NewRunRoute)),
						children: 'New run',
					}),
				}),
			)
		}

		const showMissing = (count: number) => {
			if (count === 0) {
				missingSlot.replaceChildren()
				return
			}
			missingSlot.replaceChildren(missingBar(count))
		}

		// Both read first and show together, so the bar never comes in below the link a moment later.
		const show = async (abortSignal: AbortSignal) => {
			const theApp = await readTheApp(abortSignal)
			const app = theApp.ok ? theApp.value : undefined
			const count = await missingCount(app, abortSignal)
			if (abortSignal.aborted) return
			showNewRun(app)
			showMissing(count)
		}

		const refresh = refresher(show, signal)
		// A run's status doesn't change what the app needs. A deploy sends no change: it shows on a reconnect or a reload.
		onChange((change) => {
			if (change.kind !== 'run') refresh()
		}, signal)
		refresh()
	},
})

/** How many settings `app` still needs; none without an app, or while the engine can't say. */
async function missingCount(app: DeployedApp | undefined, abortSignal: AbortSignal): Promise<number> {
	if (app === undefined) return 0
	const missing = await read(missingPath, z.array(MissingSetting), abortSignal)
	return missing.ok ? missing.value.length : 0
}
