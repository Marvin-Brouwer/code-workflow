import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { RuntimeEvent } from '@mesh-flow/protocol'
import writeFileAtomic from 'write-file-atomic'
import { hasErrorCode, messageOf } from '../errors.mts'
import { RunId } from './run-id.mts'
import { RunRecord } from './run-record.mts'

/** What {@link RunStore.loadAll} found, and the files it had to skip. */
export interface LoadedRuns {
	readonly records: RunRecord[]
	readonly problems: string[]
}

/**
 * Run records on disk, one directory per run:
 *
 * - `run.json`: the record, replaced atomically on every save;
 * - `events.jsonl`: the run's event tree, one event per line, appended;
 * - `source.tgz`: the workflow code the run started with, so a restart runs the same code.
 *
 * Writes to one run happen one after another; `flush` waits for all of them.
 */
export interface RunStore {
	/** Where the run's packed workflow source goes. */
	sourceOf(id: RunId): string
	/** Saves a copy of the record as it is now. */
	save(record: RunRecord): Promise<void>
	/** Appends events to the run's event tree. */
	appendEvents(id: RunId, events: readonly RuntimeEvent[]): Promise<void>
	/** The run's event tree so far, in the order it was appended. */
	events(id: RunId): Promise<RuntimeEvent[]>
	/**
	 * Every record on disk. A record that can't be read is skipped and reported, so one broken file
	 * doesn't keep the engine from starting.
	 */
	loadAll(): Promise<LoadedRuns>
	/** Removes what a run left behind before it had a record, such as a half-packed source. */
	removeRun(id: RunId): Promise<void>
	/** Waits for every write that has started. */
	flush(): Promise<void>
}

const recordFile = 'run.json'
const eventsFile = 'events.jsonl'
const sourceFile = 'source.tgz'

/** The directory of one run under `root`. Throws for anything that isn't a run id, such as `../etc`. */
export function runDirectory(root: string, id: string): string {
	return path.join(root, RunId.parse(id))
}

/** The run records under `root`. Nothing is read until it's asked for. */
export function openRunStore(root: string): RunStore {
	const enqueue = writeQueues()
	const file = (id: RunId, name: string) => path.join(runDirectory(root, id), name)

	return Object.freeze({
		sourceOf: (id) => file(id, sourceFile),

		save: (record) => {
			const text = `${JSON.stringify(record, null, '\t')}\n`
			return enqueue.write(record.id, async () => {
				await mkdir(runDirectory(root, record.id), { recursive: true })
				await writeFileAtomic(file(record.id, recordFile), text)
			})
		},

		appendEvents: (id, events) => {
			if (events.length === 0) return Promise.resolve()
			const text = events.map((event) => `${JSON.stringify(event)}\n`).join('')
			return enqueue.write(id, async () => {
				await mkdir(runDirectory(root, id), { recursive: true })
				await appendFile(file(id, eventsFile), text)
			})
		},

		events: async (id) => {
			const text = await readFile(file(id, eventsFile), 'utf8').catch((error: unknown) => {
				if (hasErrorCode(error, 'ENOENT')) return ''
				throw error
			})
			// The last piece is empty, or a line still being appended: it's read next time.
			return text
				.split('\n')
				.slice(0, -1)
				.filter((line) => line.length > 0)
				.map((line) => RuntimeEvent.parse(JSON.parse(line)))
		},

		loadAll: () => loadAll(root),

		removeRun: (id) => enqueue.write(id, () => rm(runDirectory(root, id), { recursive: true, force: true })),

		flush: () => enqueue.flush(),
	} satisfies RunStore)
}

async function loadAll(root: string): Promise<LoadedRuns> {
	const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
		if (hasErrorCode(error, 'ENOENT')) return []
		throw error
	})
	const records: RunRecord[] = []
	const problems: string[] = []
	for (const entry of entries) {
		if (!entry.isDirectory() || !RunId.safeParse(entry.name).success) continue
		const file = path.join(root, entry.name, recordFile)
		try {
			records.push(RunRecord.parse(JSON.parse(await readFile(file, 'utf8'))))
		} catch (error) {
			problems.push(`Skipped ${file}: ${messageOf(error)}`)
		}
	}
	records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
	return { records, problems }
}

/** Runs writes to the same key one after another, and can wait for all of them. */
function writeQueues() {
	const queues = new Map<string, Promise<void>>()
	return {
		write(key: string, write: () => Promise<void>): Promise<void> {
			const next = (queues.get(key) ?? Promise.resolve()).then(write)
			const settled = next.catch(() => undefined)
			queues.set(key, settled)
			void settled.then(() => {
				if (queues.get(key) === settled) queues.delete(key)
			})
			return next
		},
		async flush(): Promise<void> {
			await Promise.allSettled(queues.values())
		},
	}
}
