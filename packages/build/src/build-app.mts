import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { appManifestFile, type AppManifest, type AppPlatform } from '@mesh-flow/protocol'
import { build } from 'rolldown'
import { describeBuiltApp } from './describe-built-app.mts'
import { assertInstallable, installForPlatform } from './install-for-platform.mts'
import { nativePackages, type NativePackage } from './native-packages.mts'
import { packageEntry } from './package-entry.mts'

/** What `buildApp` takes. */
export interface BuildAppOptions {
	/** The app's repository, with its `package.json` and installed dependencies. */
	readonly directory: string
	/** Where the built app goes. It's emptied first, so it can't be the repository or hold it. */
	readonly out: string
	/** The sandbox's platform, which native dependencies are installed for. Default: linux-x64. */
	readonly platform?: AppPlatform
	readonly abortSignal: AbortSignal
}

/** The built file the sandbox starts with `node`. */
const builtEntry = 'main.mjs'

const defaultPlatform: AppPlatform = { os: 'linux', cpu: 'x64' }

/**
 * Builds the app in `directory` into `out`, ready to deploy: its entry file (`main` in
 * `package.json`) and everything it imports bundled into one file, the dependencies that ship
 * native code installed next to it for the sandbox's platform, and `mesh-flow.json`, which says
 * what the app declares. The sandbox then only runs `node main.mjs`: no setup, no install.
 *
 * Describing runs the built app on this machine, the way the engine would start it.
 */
export async function buildApp(options: BuildAppOptions): Promise<AppManifest> {
	const { directory, out, abortSignal } = options
	const platform = options.platform ?? defaultPlatform
	abortSignal.throwIfAborted()
	assertSafeOut(path.resolve(directory), path.resolve(out))
	const entry = await packageEntry(directory)
	const natives = await nativePackages(directory, abortSignal)
	assertInstallable(natives, platform)
	await rm(out, { recursive: true, force: true })
	await mkdir(out, { recursive: true })
	abortSignal.throwIfAborted()
	await build({
		input: entry,
		cwd: directory,
		platform: 'node',
		external: (id) => isBuiltin(id) || isNative(id, natives),
		logLevel: 'warn',
		onLog(level, log, report) {
			// Left out, the import would only fail in the sandbox.
			if (log.code === 'UNRESOLVED_IMPORT') throw new Error(`${log.message} Is it installed?`)
			report(level, log)
		},
		output: {
			file: path.join(out, builtEntry),
			format: 'esm',
			codeSplitting: false,
			// The loops' keys come from it: a call site in the source stays put when a rebuild moves the bundle's lines.
			sourcemap: true,
			sourcemapExcludeSources: true,
			sourcemapPathTransform: (source, map) => sourceName(directory, path.resolve(path.dirname(map), source)),
		},
	})
	// Described before the sandbox's binaries are installed next to it: this machine may not run them.
	const description = await describeBuiltApp({ bundle: path.join(out, builtEntry), directory, abortSignal })
	await installForPlatform(out, natives, platform, abortSignal)
	const manifest: AppManifest = { entry: builtEntry, platform, description, builtAt: new Date().toISOString() }
	await writeFile(path.join(out, appManifestFile), JSON.stringify(manifest, null, '\t'))
	return manifest
}

/** Throws when emptying `out` would delete the repository, or everything. */
function assertSafeOut(directory: string, out: string): void {
	const outward = path.relative(out, directory)
	const holdsDirectory = outward === '' || (outward.split(path.sep)[0] !== '..' && !path.isAbsolute(outward))
	if (holdsDirectory || path.dirname(out) === out) {
		throw new Error(
			`${out} is emptied before a build, and it holds the app's repository: give a folder of its own, such as .mesh-flow/app.`,
		)
	}
}

/** Marks where a package manager keeps an installed package. */
const installedPackages = 'node_modules/'

/**
 * A source file as the source map names it: relative to the repository, with `/`, and for an
 * installed package from its name on (`@mesh-flow/github/dist/github.mjs`), so where the package
 * manager keeps it, such as pnpm's folder with the versions of its peers, doesn't count.
 */
function sourceName(directory: string, file: string): string {
	const name = path.relative(directory, file).split(path.sep).join('/')
	const installed = name.lastIndexOf(installedPackages)
	return installed === -1 ? name : name.slice(installed + installedPackages.length)
}

function isNative(id: string, natives: readonly NativePackage[]): boolean {
	return natives.some((native) => id === native.name || id.startsWith(`${native.name}/`))
}
