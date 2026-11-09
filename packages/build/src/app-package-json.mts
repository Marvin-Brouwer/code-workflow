import { z } from 'zod'

/** The parts of an app's `package.json` the build reads: its entry file and its dependencies. */
export const AppPackageJson = z.object({
	main: z.string().min(1).optional(),
	dependencies: z.record(z.string(), z.string()).optional(),
})
export type AppPackageJson = z.infer<typeof AppPackageJson>
