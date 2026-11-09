import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { WorkflowsDescription } from '@mesh-flow/protocol'
import writeFileAtomic from 'write-file-atomic'
import { hasErrorCode } from '../errors.mts'

/** What entry files declare, by the source key they were described at. */
export interface DescriptionCache {
	get(sourceKey: string): Promise<WorkflowsDescription | undefined>
	set(sourceKey: string, description: WorkflowsDescription): Promise<void>
}

/** The text as JSON, or `undefined` when it isn't, such as a file cut short by a crash. */
function parseJsonOrUndefined(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/** Source keys are SHA-256 hashes; nothing else names a file. */
const sourceKeyPattern = /^[0-9a-f]{64}$/

/** A cache that lives as long as the process. */
export function memoryDescriptionCache(): DescriptionCache {
	const descriptions = new Map<string, WorkflowsDescription>()
	return Object.freeze({
		get: (sourceKey) => Promise.resolve(descriptions.get(sourceKey)),
		set: (sourceKey, description) => {
			descriptions.set(sourceKey, description)
			return Promise.resolve()
		},
	} satisfies DescriptionCache)
}

/**
 * A cache on disk, one JSON file per source key in `directory`, so an engine that starts again
 * doesn't describe the same code again. A file that can't be read is described again.
 */
export function openDescriptionCache(directory: string): DescriptionCache {
	const file = (sourceKey: string) => {
		if (!sourceKeyPattern.test(sourceKey)) throw new Error(`${sourceKey} isn't a source key.`)
		return path.join(directory, `${sourceKey}.json`)
	}
	return Object.freeze({
		async get(sourceKey) {
			const text = await readFile(file(sourceKey), 'utf8').catch((error: unknown) => {
				if (hasErrorCode(error, 'ENOENT')) return undefined
				throw error
			})
			if (text === undefined) return undefined
			const parsed = WorkflowsDescription.safeParse(parseJsonOrUndefined(text))
			return parsed.success ? parsed.data : undefined
		},
		async set(sourceKey, description) {
			await mkdir(directory, { recursive: true })
			await writeFileAtomic(file(sourceKey), JSON.stringify(description))
		},
	} satisfies DescriptionCache)
}
