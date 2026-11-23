import type { DeployedApp, TriggerDescription } from '../_shared/runs.mts'

/** A trigger that a person starts, with a button. */
export type UserTrigger = Extract<TriggerDescription, { kind: 'user' }>

/** The app's triggers that a person starts. */
export function userTriggersOf(app: DeployedApp | undefined): UserTrigger[] {
	if (app === undefined) return []
	return app.manifest.description.triggers.filter((trigger): trigger is UserTrigger => trigger.kind === 'user')
}
