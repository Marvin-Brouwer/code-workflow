import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { AppName } from '../apps/names.mts'

/**
 * The app's name: `given`, or else the name in `package.json` in `directory`, with an npm scope
 * folded in (`@team/workflows` is `team-workflows`).
 */
export async function appNameOf(directory: string, given: string | undefined): Promise<string> {
	if (given !== undefined) return AppName.parse(given)
	const json: unknown = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
	const { name } = z.object({ name: z.string().optional() }).parse(json)
	if (name === undefined) throw new Error(`${directory}/package.json has no name: give the app one with --app.`)
	const folded = name.replace(/^@/, '').replace('/', '-')
	const parsed = AppName.safeParse(folded)
	if (!parsed.success) throw new Error(`${name} doesn't make an app name: give one with --app, in lowercase letters, digits and dashes.`)
	return parsed.data
}
