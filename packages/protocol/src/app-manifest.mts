import { z } from 'zod'
import { WorkflowsDescription } from './workflows-description.mts'

/** The file in a built app that says what it is: an {@link AppManifest}. */
export const appManifestFile = 'mesh-flow.json'

/** The platform a built app's native dependencies were installed for, as Node names it. */
export const AppPlatform = z.object({
	os: z.literal('linux'),
	cpu: z.enum(['x64', 'arm64']),
})
export type AppPlatform = z.infer<typeof AppPlatform>

/**
 * What `mesh-flow build` writes next to a built app, and what the engine reads from a deployed one:
 * the file to start with `node`, the platform it was built for, and what the app declares. The
 * engine never runs the app to learn it.
 */
export const AppManifest = z.object({
	/** The built entry file, relative to the app's folder. */
	entry: z.string().min(1),
	platform: AppPlatform,
	description: WorkflowsDescription,
	/** When it was built, as an ISO time. */
	builtAt: z.iso.datetime(),
})
export type AppManifest = z.infer<typeof AppManifest>
