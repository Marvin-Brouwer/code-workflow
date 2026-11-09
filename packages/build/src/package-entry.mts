import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { AppPackageJson } from './app-package-json.mts'

/** The app's entry file, from `main` in its `package.json`, as an absolute path. Throws when there is none. */
export async function packageEntry(directory: string): Promise<string> {
	const file = path.join(directory, 'package.json')
	let json: unknown
	try {
		json = JSON.parse(await readFile(file, 'utf8'))
	} catch (error) {
		throw new Error(`There is no readable package.json in ${directory}.`, { cause: error })
	}
	const { main } = AppPackageJson.parse(json)
	if (main === undefined) throw new Error(`${file} has no "main": point it at the entry file, the one that exports defineMeshFlow.`)
	return path.resolve(directory, main)
}
