import { read, type Answer } from './api.mts'
import { DeployedApp } from './runs.mts'

/** The path of what the app still needs before a run can start. */
export const missingPath = '/engine/app/missing'

/** The app the engine runs, or `undefined` before one is deployed. */
export async function readTheApp(abortSignal: AbortSignal): Promise<Answer<DeployedApp | undefined>> {
	const app = await read('/engine/app', DeployedApp.nullable(), abortSignal)
	if (!app.ok) return app
	return { ok: true, value: app.value ?? undefined }
}
