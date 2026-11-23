import { component } from '@rooted/components'
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
					count === 1
						? 'The app still needs 1 setting before a run can start. '
						: `The app still needs ${count} settings before a run can start. `,
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
						href: others.length === 0 ? href.for(StartRoute, { trigger: only.id }) : href.for(NewRunRoute),
						children: 'New run',
					}),
				}),
			)
		}

		const showMissing = async (app: DeployedApp | undefined, abortSignal: AbortSignal) => {
			if (app === undefined) {
				missingSlot.replaceChildren()
				return
			}
			const missing = await read(missingPath(app), z.array(MissingSetting), abortSignal)
			if (abortSignal.aborted) return
			const count = missing.ok ? missing.value.length : 0
			if (count === 0) {
				missingSlot.replaceChildren()
				return
			}
			missingSlot.replaceChildren(missingBar(count))
		}

		const show = async (abortSignal: AbortSignal) => {
			const theApp = await readTheApp(abortSignal)
			if (abortSignal.aborted) return
			const app = theApp.ok ? theApp.value : undefined
			showNewRun(app)
			await showMissing(app, abortSignal)
		}

		const refresh = refresher(show, signal)
		onChange(() => {
			refresh()
		}, signal)
		refresh()
	},
})
