import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AppManifest, appManifestFile } from '@mesh-flow/protocol'
import { SandboxSpec } from '@mesh-flow/sandbox'
import * as tar from 'tar'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { EngineError } from '../engine/engine-error.mts'
import { hasErrorCode, messageOf } from '../errors.mts'
import { copyTarball } from './copy-tarball.mts'
import { AppName } from './names.mts'

/** One deployed version of an app: its tarball and what it declares. Versions never change. */
export interface AppVersion {
	readonly name: string
	/** The first characters of the tarball's SHA-256: the same build deploys as the same version. */
	readonly version: string
	readonly manifest: AppManifest
	/** The built app, packed: what a run's sandbox gets. */
	readonly tarball: string
}

/** The deployed apps in the engine's home, each with its current version. */
export interface AppStore {
	/** Makes the built app packed in `tarball` the current version of `name`. */
	readonly deploy: (name: string, tarball: string, abortSignal: AbortSignal) => Promise<AppVersion>
	/** The current version of `name`, if it was ever deployed. */
	readonly current: (name: string) => AppVersion | undefined
	/** Every app's current version. */
	readonly list: () => AppVersion[]
	/** Forgets an app. Runs that started on it keep their own copy. Whether there was one. */
	readonly remove: (name: string, abortSignal: AbortSignal) => Promise<boolean>
	/** Waits for the writes under way and refuses new ones, so the engine's home can be let go. */
	readonly close: () => Promise<void>
}

/** How many hex characters of the tarball's hash name a version. */
const versionLength = 12

const tarballFile = 'app.tgz'
const currentFile = 'current'

/**
 * What a removed app's folder is renamed to start with before it's deleted. `AppName` never starts
 * with a dot, so `openAppStore` never takes such a folder for an app.
 */
const removedPrefix = '.removed-'

/**
 * The apps in `root`, one folder per app, one folder per version in it, and a `current` file that
 * names the version that runs. Loads what's there, as long as `openSignal` allows; an app that
 * can't be read is left out and reported to `log`, so one broken app doesn't keep the rest from
 * running. Writes go one after another.
 */
export async function openAppStore(
	root: string,
	openSignal: AbortSignal,
	log: (message: string) => void = () => undefined,
): Promise<AppStore> {
	await mkdir(root, { recursive: true })
	const current = new Map<string, AppVersion>()
	for (const entry of await readdir(root, { withFileTypes: true })) {
		openSignal.throwIfAborted()
		if (entry.isDirectory() && entry.name.startsWith(removedPrefix)) {
			// Left by a removal that crashed after moving the app aside.
			await rm(path.join(root, entry.name), { recursive: true, force: true })
			continue
		}
		if (!entry.isDirectory() || !AppName.safeParse(entry.name).success) continue
		try {
			const loaded = await loadCurrent(root, entry.name)
			if (loaded !== undefined) current.set(entry.name, loaded)
		} catch (error) {
			log(`Left out app ${entry.name}: ${messageOf(error)} Deploy it again.`)
		}
	}
	let writing: Promise<unknown> = Promise.resolve()
	let closed = false
	const queued = <T,>(write: () => Promise<T>): Promise<T> => {
		if (closed) return Promise.reject(new EngineError('conflict', 'The engine is shutting down.'))
		const next = writing.then(write)
		writing = next.catch(() => undefined)
		return next
	}
	return Object.freeze({
		deploy: (name, tarball, abortSignal) =>
			queued(async () => {
				abortSignal.throwIfAborted()
				if (!AppName.safeParse(name).success)
					throw new EngineError('invalid', `${name} isn't an app name: use lowercase letters, digits and dashes.`)
				const version = (await sha256Of(tarball, abortSignal)).slice(0, versionLength)
				const folder = path.join(root, name, version)
				const manifest = await manifestIn(tarball)
				abortSignal.throwIfAborted()
				// A version never changes, and runs may be copying it right now: a redeploy of the same build leaves it be.
				if (!(await versionIsComplete(folder))) {
					await mkdir(folder, { recursive: true })
					await copyTarball(tarball, path.join(folder, tarballFile), abortSignal)
					// Written last: it marks the version complete.
					await writeFileAtomic(path.join(folder, appManifestFile), JSON.stringify(manifest, null, '\t'))
				}
				abortSignal.throwIfAborted()
				await writeFileAtomic(path.join(root, name, currentFile), version)
				const deployed: AppVersion = { name, version, manifest, tarball: path.join(folder, tarballFile) }
				current.set(name, deployed)
				return deployed
			}),
		current: (name) => current.get(name),
		list: () => [...current.values()],
		remove: (name, abortSignal) =>
			queued(async () => {
				abortSignal.throwIfAborted()
				if (!current.has(name)) return false
				// Moved aside first, so a crash halfway leaves no half app behind; forgotten only once that worked.
				const gone = path.join(root, `${removedPrefix}${name}-${Date.now().toString(36)}`)
				await rename(path.join(root, name), gone)
				current.delete(name)
				await rm(gone, { recursive: true, force: true })
				return true
			}),
		close: async () => {
			closed = true
			await writing
		},
	} satisfies AppStore)
}

/** Whether a version's folder holds its tarball and its manifest, which is written last. */
async function versionIsComplete(folder: string): Promise<boolean> {
	return (await Promise.all([pathExists(path.join(folder, tarballFile)), pathExists(path.join(folder, appManifestFile))])).every(Boolean)
}

async function pathExists(file: string): Promise<boolean> {
	try {
		await stat(file)
		return true
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return false
		throw error
	}
}

/** The version `current` names in an app's folder, or nothing for a folder left half made. */
async function loadCurrent(root: string, name: string): Promise<AppVersion | undefined> {
	try {
		const version = (await readFile(path.join(root, name, currentFile), 'utf8')).trim()
		const folder = path.join(root, name, version)
		const manifest = AppManifest.parse(JSON.parse(await readFile(path.join(folder, appManifestFile), 'utf8')))
		return { name, version, manifest, tarball: path.join(folder, tarballFile) }
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return undefined
		throw new Error(`Its current version in ${path.join(root, name)} can't be read: ${messageOf(error)}`, { cause: error })
	}
}

/** The manifest packed in a built app's tarball, checked against what the engine's sandboxes take. */
async function manifestIn(tarball: string): Promise<AppManifest> {
	let text: string | undefined
	await listTarball({
		file: tarball,
		filter: (entry) => entry.replace(/^\.\//, '') === appManifestFile,
		onReadEntry: (entry) => {
			const chunks: Buffer[] = []
			entry.on('data', (chunk: Buffer) => chunks.push(chunk))
			entry.on('end', () => {
				text = Buffer.concat(chunks).toString('utf8')
			})
		},
	})
	if (text === undefined) throw new EngineError('invalid', `The app has no ${appManifestFile}: deploy what mesh-flow build wrote.`)
	const parsed = AppManifest.safeParse(parseJsonOrUndefined(text))
	if (!parsed.success) throw new EngineError('invalid', `The app's ${appManifestFile} isn't valid:\n${z.prettifyError(parsed.error)}`)
	const sandbox = SandboxSpec.safeParse(parsed.data.description.sandbox)
	if (!sandbox.success)
		throw new EngineError('invalid', `The app's sandbox isn't one the engine can make:\n${z.prettifyError(sandbox.error)}`)
	return parsed.data
}

/** The value `text` holds as JSON, or nothing when it isn't JSON. */
function parseJsonOrUndefined(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/** The SHA-256 of a tarball, in hex. A tarball that isn't there is the caller's mistake. */
async function sha256Of(file: string, abortSignal: AbortSignal): Promise<string> {
	const hash = createHash('sha256')
	try {
		await pipeline(createReadStream(file), hash, { signal: abortSignal })
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) throw new EngineError('invalid', `There is no tarball at ${file}.`)
		throw error
	}
	return hash.digest('hex')
}

/** `tar.list`, with a file that can't be read as a tarball, corrupt or not one at all, as the caller's mistake. */
async function listTarball(options: tar.TarOptionsWithAliasesAsyncFile): Promise<void> {
	try {
		await tar.list(options)
	} catch (error) {
		throw new EngineError('invalid', `${options.file} can't be read as a tarball (${messageOf(error)}): deploy what mesh-flow build wrote.`)
	}
}
