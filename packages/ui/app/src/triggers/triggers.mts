import { component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { z } from 'zod'
import { Table } from '../_layout/table.mts'
import { read } from '../_shared/api.mts'
import { errorText } from '../_shared/error-text.mts'
import { noAppText } from '../_shared/no-app-text.mts'
import type { TriggerDescription } from '../_shared/runs.mts'
import { readTheApp } from '../_shared/the-app.mts'
import { shownTime } from '../runs/run-labels.mts'
import { CredentialsRoute } from '../settings/_routes.mts'
import { StartRoute } from '../start/_routes.mts'

/**
 * The app's triggers, with a start link for those a person starts, the schedule of those that run
 * on one, and whether a webhook's secret is set.
 */
export const TriggersPage = component({
	name: 'triggers-page',
	async onMount({ append, element, create, signal }) {
		append(
			element('h1', {
				textContent: 'Triggers',
			}),
		)
		const [theApp, credentials] = await Promise.all([readTheApp(signal), read('/settings/credentials', z.array(z.string()), signal)])
		if (!theApp.ok) {
			append(errorText(element, theApp.error))
			return
		}
		const app = theApp.value
		if (app === undefined) {
			append(noAppText(element))
			return
		}
		const secrets = new Set(credentials.ok ? credentials.value : [])

		const detail = (trigger: TriggerDescription) => {
			if (trigger.kind === 'user')
				return create(Link, {
					href: href.for(StartRoute, { trigger: trigger.id }),
					children: 'Start',
				})
			if (trigger.kind === 'schedule')
				return element('code', {
					textContent: trigger.cron,
				})
			const name = `webhook/${trigger.id}`
			if (secrets.has(name))
				return element('span', {
					textContent: 'Secret set',
				})
			return element('span', {
				children: [
					'No secret: set ',
					element('code', {
						textContent: name,
					}),
					' under ',
					create(Link, {
						href: href.for(CredentialsRoute),
						children: 'credentials',
					}),
				],
			})
		}

		append(
			element('p', {
				textContent: `Version ${app.version}, built ${shownTime(app.manifest.builtAt)}.`,
			}),
			create(Table, {
				headings: ['Trigger', 'Kind', 'Workflow', ''],
				rows: app.manifest.description.triggers.map((trigger) =>
					element('tr', {
						children: [
							element('td', {
								textContent: trigger.id,
							}),
							element('td', {
								textContent: trigger.kind,
							}),
							element('td', {
								textContent: trigger.workflow,
							}),
							element('td', {
								children: detail(trigger),
							}),
						],
					}),
				),
			}),
		)
	},
})
