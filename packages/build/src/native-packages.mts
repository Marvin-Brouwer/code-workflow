import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { AppPackageJson } from './app-package-json.mts'

/** The parts of a dependency's `package.json` that say whether it ships native code. */
const DependencyPackage = z.object({
	name: z.string(),
	version: z.string(),
	gypfile: z.boolean().optional(),
	dependencies: z.record(z.string(), z.string()).optional(),
	optionalDependencies: z.record(z.string(), z.string()).optional(),
})

/** A dependency the bundle can't hold, because it ships or builds native code. */
export interface NativePackage {
	readonly name: string
	readonly version: string
	/** It compiles its native code when installed, rather than downloading a prebuilt one. */
	readonly buildsFromSource: boolean
}

/**
 * The dependencies of the app in `directory`, direct or not, that ship native code: an addon
 * built with node-gyp, prebuilt binaries, or platform-specific optional packages (as esbuild has).
 * The bundle leaves these out, and the build installs them for the sandbox's platform instead.
 */
export async function nativePackages(directory: string, abortSignal: AbortSignal): Promise<NativePackage[]> {
	const found = new Map<string, NativePackage>()
	const visited = new Set<string>()
	const visit = async (from: string, names: readonly string[]) => {
		for (const name of names) {
			abortSignal.throwIfAborted()
			const folder = packageFolder(name, from)
			if (folder === undefined || visited.has(folder)) continue
			visited.add(folder)
			const json = DependencyPackage.parse(JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')))
			const buildsFromSource = json.gypfile === true || existsSync(path.join(folder, 'binding.gyp'))
			const prebuilt = existsSync(path.join(folder, 'prebuilds')) || Object.keys(json.optionalDependencies ?? {}).length > 0
			if (buildsFromSource || prebuilt) {
				found.set(json.name, { name: json.name, version: json.version, buildsFromSource: buildsFromSource && !prebuilt })
				continue
			}
			await visit(folder, Object.keys(json.dependencies ?? {}))
		}
	}
	const { dependencies } = AppPackageJson.parse(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')))
	await visit(directory, Object.keys(dependencies ?? {}))
	return [...found.values()]
}

/** Where `name` resolves from `from`, as Node finds it: the nearest `node_modules/<name>` up the tree. */
function packageFolder(name: string, from: string): string | undefined {
	for (let folder = path.resolve(from); ; folder = path.dirname(folder)) {
		const candidate = path.join(folder, 'node_modules', name)
		if (existsSync(path.join(candidate, 'package.json'))) return candidate
		if (path.dirname(folder) === folder) return undefined
	}
}
