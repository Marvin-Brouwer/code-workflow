import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { RunRecord } from '../src/runs/run-record.mts'
import { openRunStore, runDirectory } from '../src/runs/run-store.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

function record(id: string, createdAt: string): RunRecord {
	return {
		id,
		workflow: 'develop',
		source: { directory: '/repository', commit: 'abc', dirty: false },
		config: {
			sandbox: { image: 'node:22-slim', cpus: 1, memoryMb: 512, egress: { allow: [] } },
			setup: [],
			start: ['node'],
			workflows: 'workflows',
		},
		status: 'running',
		cursor: 3,
		pending: [{ kind: 'input', id: 'story', question: 'Which story?', fields: {} }],
		createdAt,
		updatedAt: createdAt,
	}
}

describe('openRunStore', () => {
	test('loads what it saved, oldest first', async () => {
		// Arrange
		const store = openRunStore(await temporaryDirectory())
		const newer = record('run-00000000000b', '2026-11-07T12:00:00.000Z')
		const older = record('run-00000000000a', '2026-11-06T12:00:00.000Z')

		// Act
		await Promise.all([store.save(newer), store.save(older)])
		const { records, problems } = await store.loadAll()

		// Assert
		expect(records).toEqual([older, newer])
		expect(problems).toEqual([])
	})

	test('leaves an event that is still being appended for the next read', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const store = openRunStore(root)
		await store.appendEvents('run-00000000000a', [{ id: '1', type: 'started', at: '2026-11-07T12:00:00.000Z' }])
		await appendFile(path.join(runDirectory(root, 'run-00000000000a'), 'events.jsonl'), '{"id":"2","ty')

		// Act
		const events = await store.events('run-00000000000a')

		// Assert
		expect(events.map((event) => event.id)).toEqual(['1'])
	})

	test('keeps the last of several saves of one run', async () => {
		// Arrange
		const store = openRunStore(await temporaryDirectory())
		const first = record('run-00000000000a', '2026-11-07T12:00:00.000Z')

		// Act
		void store.save(first)
		void store.save({ ...first, cursor: 4 })
		await store.save({ ...first, cursor: 5 })
		const { records } = await store.loadAll()

		// Assert
		expect(records.map((loaded) => loaded.cursor)).toEqual([5])
	})

	test('skips and reports a record it cannot read', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const store = openRunStore(directory)
		await store.save(record('run-00000000000a', '2026-11-07T12:00:00.000Z'))
		await mkdir(path.join(directory, 'run-00000000000b'))
		await writeFile(path.join(directory, 'run-00000000000b', 'run.json'), '{ "half": ')

		// Act
		const { records, problems } = await store.loadAll()

		// Assert
		expect(records).toHaveLength(1)
		expect(problems).toEqual([expect.stringContaining('run-00000000000b')])
	})

	test('lists a run directory without a record as an orphan', async () => {
		// Arrange
		const root = await temporaryDirectory()
		const store = openRunStore(root)
		await store.save(record('run-00000000000a', '2026-11-06T12:00:00.000Z'))
		await mkdir(runDirectory(root, 'run-00000000000b'))

		// Act
		const { records, orphans } = await store.loadAll()

		// Assert
		expect(records.map((loaded) => loaded.id)).toEqual(['run-00000000000a'])
		expect(orphans).toEqual(['run-00000000000b'])
	})

	test('appends events and reads them back in order', async () => {
		// Arrange
		const store = openRunStore(await temporaryDirectory())
		const at = '2026-11-07T12:00:00.000Z'

		// Act
		await store.appendEvents('run-00000000000a', [{ id: '1', type: 'started', at }])
		await store.appendEvents('run-00000000000a', [{ id: '2', parentId: '1', type: 'log', at, line: 'hello' }])

		// Assert
		expect(await store.events('run-00000000000a')).toEqual([
			{ id: '1', type: 'started', at },
			{ id: '2', parentId: '1', type: 'log', at, line: 'hello' },
		])
	})

	test('refuses an id that is not a run id', () => {
		// Arrange
		const root = '/runs'

		// Act
		const resolve = () => runDirectory(root, '../etc')

		// Assert
		expect(resolve).toThrow()
	})
})
