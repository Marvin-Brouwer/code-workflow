import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AppManifest, appManifestFile } from '@mesh-flow/protocol'
import { SandboxSpec } from '@mesh-flow/sandbox'
import * as tar from 'tar'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { EngineError } from '../engine/engine-error.mts'
import { hasErrorCode, messageOf } from '../errors.mts'
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
 * names the version that runs. Loads what's there, as long as `openSignal` allows; writes go one
 * after another.
 */
export async function openAppStore(root: string, openSignal: AbortSignal): Promise<AppStore> {
	await mkdir(root, { recursive: true })
	const current = new Map<string, AppVersion>()
	for (const entry of await readdir(root, { withFileTypes: true })) {
		openSignal.throwIfAborted()
		if (!entry.isDirectory() || !AppName.safeParse(entry.name).success) continue
		const loaded = await loadCurrent(root, entry.name)
		if (loaded !== undefined) current.set(entry.name, loaded)
	}
	let writing: Promise<unknown> = Promise.resolve()
	const queued = <T,>(write: () => Promise<T>): Promise<T> => {
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
				await mkdir(folder, { recursive: true })
				await copyFile(tarball, path.join(folder, tarballFile))
				abortSignal.throwIfAborted()
				await writeFileAtomic(path.join(folder, appManifestFile), JSON.stringify(manifest, null, '\t'))
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
				if (!current.delete(name)) return false
				// Moved aside first, so a crash halfway leaves no half app behind.
				const gone = path.join(root, `${removedPrefix}${name}-${Date.now().toString(36)}`)
				await rename(path.join(root, name), gone)
				await rm(gone, { recursive: true, force: true })
				return true
			}),
	} satisfies AppStore)
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
		throw new Error(`The app ${name} in ${root} can't be read: ${messageOf(error)}`, { cause: error })
	}
}

/** The manifest packed in a built app's tarball, checked against what the engine's sandboxes take. */
async function manifestIn(tarball: string): Promise<AppManifest> {
	let text: string | undefined
	await tar.list({
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
