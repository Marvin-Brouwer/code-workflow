import { z } from 'zod'
import { read, type Answer } from './api.mts'
import { DeployedApp } from './runs.mts'

/**
 * The app the engine runs, or `undefined` before one is deployed. mesh-flow runs one app; until the
 * engine knows that too (issue #57), this is the first by name, so it
 * stays the same app across engine restarts.
 */
export async function readTheApp(abortSignal: AbortSignal): Promise<Answer<DeployedApp | undefined>> {
	const apps = await read('/engine/apps', z.array(DeployedApp), abortSignal)
	if (!apps.ok) return apps
	return { ok: true, value: apps.value.toSorted((first, second) => first.name.localeCompare(second.name))[0] }
}

/** The path of what `app` still needs before a run can start. */
export function missingPath(app: DeployedApp): string {
	return `/engine/apps/${encodeURIComponent(app.name)}/missing`
}
