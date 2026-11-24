import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { replaceFile } from '@mesh-flow/gateway'
import { AppManifest, appManifestFile } from '@mesh-flow/protocol'
import { SandboxSpecification } from '@mesh-flow/sandbox'
import * as tar from 'tar'
import { z } from 'zod'
import { EngineError } from '../engine/engine-error.mts'
import { hasErrorCode, messageOf } from '../errors.mts'
import { copyTarball } from './copy-tarball.mts'

/** One deployed version of the app: its tarball and what it declares. A version never changes. */
export interface DeploymentVersion {
	/** The first characters of the tarball's SHA-256: the same build deploys as the same version. */
	readonly version: string
	readonly manifest: AppManifest
	/** The built app, packed: what a run's sandbox gets. */
	readonly tarball: string
}

/**
 * The app deployed in the engine's home: its current version, kept on disk so it's there after a
 * restart. Older versions are removed once no run copies them.
 */
export interface Deployment {
	/** Makes the built app packed in `tarball` the current version. */
	readonly deploy: (tarball: string, abortSignal: AbortSignal) => Promise<DeploymentVersion>
	/** The current version, if the app was ever deployed. */
	readonly current: () => DeploymentVersion | undefined
	/**
	 * Calls `use` with the current version, and keeps that version on disk until what `use` returns
	 * settles, also when a deploy makes another version current meanwhile. For copying it.
	 */
	readonly withCurrent: <Result>(use: (current: DeploymentVersion | undefined) => Promise<Result>) => Promise<Result>
	/** Waits for the writes under way and refuses new ones, so the engine's home can be let go. */
	readonly close: () => Promise<void>
}

/** What the engine answers when a trigger or a settings check comes before the first deploy. */
export const noAppMessage = 'There is no app: deploy it first.'

/** How many hex characters of the tarball's hash name a version. */
const versionLength = 12

/** What a version's name looks like: the start of a SHA-256 in hex. */
const versionPattern = new RegExp(`^[0-9a-f]{${String(versionLength)}}$`)

const tarballFile = 'app.tgz'
const currentFile = 'current'

/**
 * The app in `root`: a folder for the current version, and a `current` file that names it. Loads
 * what's there, as long as `openSignal` allows; a current version that can't be read is reported to
 * `log` and left out, so the engine still starts and a deploy fixes it. Writes go one after another.
 *
 * A deploy writes the new version's folder whole before `current` names it, then removes the other
 * folders that no `withCurrent` holds; a folder held is removed once it's let go. A removal that
 * fails is reported to `log` and tried again after the next deploy, or the next open.
 */
export async function openDeployment(
	root: string,
	openSignal: AbortSignal,
	log: (message: string) => void = () => undefined,
): Promise<Deployment> {
	await mkdir(root, { recursive: true })
	openSignal.throwIfAborted()
	let current = await loadCurrent(root).catch((error: unknown) => {
		log(`Left out the app: ${messageOf(error)} Deploy it again.`)
		return undefined
	})
	/** How many `withCurrent` calls hold each version. */
	const holders = new Map<string, number>()
	let writing: Promise<unknown> = Promise.resolve()
	let closed = false
	const queued = <Result,>(write: () => Promise<Result>): Promise<Result> => {
		if (closed) return Promise.reject(new EngineError('conflict', 'The engine is shutting down.'))
		const next = writing.then(write)
		writing = next.catch(() => undefined)
		return next
	}
	/** Removes the version folders that aren't current and that nothing holds. Never throws: what's left is tried again later. */
	const removeOldVersions = async () => {
		try {
			for (const entry of await readdir(root, { withFileTypes: true })) {
				if (!entry.isDirectory() || entry.name === current?.version || holders.has(entry.name)) continue
				await rm(path.join(root, entry.name), { recursive: true, force: true })
			}
		} catch (error) {
			log(`Removing an older version in ${root} failed, so it's tried again later: ${messageOf(error)}`)
		}
	}
	// Removed when a crash or a failed removal left them, before anything can hold one.
	if (current !== undefined) await removeOldVersions()
	return Object.freeze({
		deploy: (tarball, abortSignal) =>
			queued(async () => {
				abortSignal.throwIfAborted()
				const version = (await sha256Of(tarball, abortSignal)).slice(0, versionLength)
				const folder = path.join(root, version)
				const manifest = await manifestIn(tarball)
				abortSignal.throwIfAborted()
				// Runs may be copying it right now: a redeploy of the same build leaves it be.
				if (!(await versionIsComplete(folder))) {
					await mkdir(folder, { recursive: true })
					await copyTarball(tarball, path.join(folder, tarballFile), abortSignal)
					// Written last: it marks the version complete.
					await replaceFile(path.join(folder, appManifestFile), JSON.stringify(manifest, null, '\t'), { abortSignal })
				}
				abortSignal.throwIfAborted()
				await replaceFile(path.join(root, currentFile), version, { abortSignal })
				const deployed: DeploymentVersion = { version, manifest, tarball: path.join(folder, tarballFile) }
				current = deployed
				await removeOldVersions()
				return deployed
			}),
		current: () => current,
		withCurrent: async (use) => {
			// Taken before anything is awaited, so a deploy that lands meanwhile leaves this version be.
			const held = current
			if (held === undefined) return use(undefined)
			holders.set(held.version, (holders.get(held.version) ?? 0) + 1)
			try {
				return await use(held)
			} finally {
				const left = (holders.get(held.version) ?? 1) - 1
				if (left > 0) holders.set(held.version, left)
				else {
					holders.delete(held.version)
					if (held.version !== current?.version && !closed) void queued(removeOldVersions)
				}
			}
		},
		close: async () => {
			closed = true
			await writing
		},
	} satisfies Deployment)
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

/**
 * The version `current` names, or nothing before the first deploy, when there is no `current`. A
 * `current` that names no complete version, such as one whose folder was removed by hand, throws.
 */
async function loadCurrent(root: string): Promise<DeploymentVersion | undefined> {
	const named = await readFile(path.join(root, currentFile), 'utf8').catch((error: unknown) => {
		if (hasErrorCode(error, 'ENOENT')) return undefined
		throw error
	})
	if (named === undefined) return undefined
	try {
		const version = named.trim()
		if (!versionPattern.test(version)) throw new Error(`${JSON.stringify(version)} isn't a version.`)
		const folder = path.join(root, version)
		const manifest = AppManifest.parse(JSON.parse(await readFile(path.join(folder, appManifestFile), 'utf8')))
		return { version, manifest, tarball: path.join(folder, tarballFile) }
	} catch (error) {
		throw new Error(`Its current version in ${root} can't be read: ${messageOf(error)}`, { cause: error })
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
	const sandbox = SandboxSpecification.safeParse(parsed.data.description.sandbox)
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
