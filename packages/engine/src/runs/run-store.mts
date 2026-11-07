import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { messageOf } from '../error-code.mts'
import { RuntimeEvent } from '../protocol/runtime-message.mts'
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
export class RunStore {
	readonly #directory: string
	readonly #queues = new Map<string, Promise<void>>()

	constructor(directory: string) {
		this.#directory = directory
	}

	directoryOf(id: RunId): string {
		return path.join(this.#directory, RunId.parse(id))
	}

	sourceOf(id: RunId): string {
		return path.join(this.directoryOf(id), 'source.tgz')
	}

	/** Saves a copy of the record as it is now. */
	save(record: RunRecord): Promise<void> {
		const text = `${JSON.stringify(record, null, '\t')}\n`
		return this.#enqueue(record.id, async () => {
			await mkdir(this.directoryOf(record.id), { recursive: true })
			await writeFileAtomic(path.join(this.directoryOf(record.id), 'run.json'), text)
		})
	}

	appendEvents(id: RunId, events: readonly RuntimeEvent[]): Promise<void> {
		if (events.length === 0) return Promise.resolve()
		const text = events.map((event) => `${JSON.stringify(event)}\n`).join('')
		return this.#enqueue(id, async () => {
			await mkdir(this.directoryOf(id), { recursive: true })
			await appendFile(path.join(this.directoryOf(id), 'events.jsonl'), text)
		})
	}

	async events(id: RunId): Promise<RuntimeEvent[]> {
		const text = await readFile(path.join(this.directoryOf(id), 'events.jsonl'), 'utf8').catch(() => '')
		return text
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => RuntimeEvent.parse(JSON.parse(line)))
	}

	/**
	 * Every record on disk. A record that can't be read is skipped and reported, so one broken file
	 * doesn't keep the engine from starting.
	 */
	async loadAll(): Promise<LoadedRuns> {
		const entries = await readdir(this.#directory, { withFileTypes: true }).catch(() => [])
		const records: RunRecord[] = []
		const problems: string[] = []
		for (const entry of entries) {
			if (!entry.isDirectory() || !RunId.safeParse(entry.name).success) continue
			const file = path.join(this.#directory, entry.name, 'run.json')
			try {
				records.push(RunRecord.parse(JSON.parse(await readFile(file, 'utf8'))))
			} catch (error) {
				problems.push(`Skipped ${file}: ${messageOf(error)}`)
			}
		}
		records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
		return { records, problems }
	}

	/** Waits for every write that has started. */
	async flush(): Promise<void> {
		await Promise.allSettled(this.#queues.values())
	}

	#enqueue(id: string, write: () => Promise<void>): Promise<void> {
		const next = (this.#queues.get(id) ?? Promise.resolve()).then(write)
		const settled = next.catch(() => undefined)
		this.#queues.set(id, settled)
		void settled.then(() => {
			if (this.#queues.get(id) === settled) this.#queues.delete(id)
		})
		return next
	}
}
