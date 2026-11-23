import { component } from '@rooted/components'
import { href, Link } from '@rooted/router'
import { z } from 'zod'
import { read } from '../_shared/api.mts'
import { DeployedApp, type TriggerDescription } from '../_shared/runs.mts'
import { shownTime } from '../runs/run-labels.mts'
import { Table } from '../_layout/table.mts'
import { CredentialsRoute } from '../settings/_routes.mts'
import { StartRoute } from './_routes.mts'

/**
 * The deployed apps: each app's triggers, with a start button for those a person starts, the
 * schedule of those that run on one, and whether a webhook's secret is set.
 */
export const AppsPage = component({
	name: 'apps-page',
	async onMount({ append, element, create, signal }) {
		append(
			element('h1', {
				textContent: 'Apps',
			}),
		)
		const [apps, credentials] = await Promise.all([
			read('/engine/apps', z.array(DeployedApp), signal),
			read('/settings/credentials', z.array(z.string()), signal),
		])
		if (!apps.ok) {
			append(
				element('p', {
					role: 'alert',
					textContent: apps.error,
				}),
			)
			return
		}
		if (apps.value.length === 0) {
			append(
				element('p', {
					textContent: 'No apps yet. Deploy one with `mesh-flow deploy`.',
				}),
			)
			return
		}
		const secrets = new Set(credentials.ok ? credentials.value : [])

		const detail = (app: DeployedApp, trigger: TriggerDescription) => {
			if (trigger.kind === 'user')
				return create(Link, {
					href: href.for(StartRoute, { app: app.name, trigger: trigger.id }),
					children: 'Start',
				})
			if (trigger.kind === 'schedule')
				return element('code', {
					textContent: trigger.cron,
				})
			const name = `webhook/${app.name}/${trigger.id}`
			return secrets.has(name)
				? element('span', {
						textContent: 'Secret set',
					})
				: element('span', {
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

		for (const app of apps.value)
			append(
				element('section', {
					children: [
						element('h2', {
							textContent: app.name,
						}),
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
											children: detail(app, trigger),
										}),
									],
								}),
							),
						}),
					],
				}),
			)
	},
})
