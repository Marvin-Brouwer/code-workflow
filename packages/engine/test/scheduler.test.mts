import type { TriggerDescription } from '@mesh-flow/protocol'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import type { DeploymentVersion } from '../src/app/deployment.mts'
import type { StartRunOptions } from '../src/engine/engine.mts'
import type { RunRecord, RunStatus } from '../src/runs/run-record.mts'
import { createScheduler } from '../src/triggers/scheduler.mts'

/** The sandbox a run record keeps, and the app's description of it, which adds the registries. */
const sandbox = { image: 'host', cpus: 1, memoryMb: 512 }
const sandboxDescription = { ...sandbox, registries: [] }
const everySecond = { kind: 'schedule' as const, id: 'report * * * * * *', workflow: 'report', cron: '* * * * * *' }
const everyOtherSecond = { kind: 'schedule' as const, id: 'report */2 * * * * *', workflow: 'report', cron: '*/2 * * * * *' }

/** Version `version` of the app, listing `triggers`. */
function appVersion(version: string, triggers: TriggerDescription[] = [everySecond]): DeploymentVersion {
	return {
		version,
		manifest: {
			entry: 'main.mjs',
			platform: { os: 'linux', cpu: 'x64' },
			description: {
				sandbox: sandboxDescription,
				workflows: [{ name: 'report', parameters: { type: 'object' } }],
				triggers,
				tools: [],
				models: [],
			},
			builtAt: '2026-11-09T09:00:00.000Z',
		},
		tarball: `/app/${version}/app.tgz`,
	}
}

/** An engine that records the runs it's asked to start, each with `status`, and starts nothing. */
function fakeEngine(status: RunStatus = 'running') {
	const runs: RunRecord[] = []
	const startRun = vi.fn((options: StartRunOptions) => {
		const at = new Date().toISOString()
		const record: RunRecord = {
			id: `run-${String(runs.length).padStart(12, '0')}`,
			workflow: 'report',
			trigger: options.trigger,
			app: {
				version: 'v1',
				entry: 'main.mjs',
				sandbox,
				tools: [],
				registries: [],
			},
			status,
			cursor: 0,
			pending: [],
			createdAt: at,
			updatedAt: at,
		}
		runs.push(record)
		return Promise.resolve(record)
	})
	return { engine: { list: () => runs, startRun }, runs, startRun }
}

/** A scheduler on `engine`, closed when the test ends. */
function openScheduler(engine: ReturnType<typeof fakeEngine>['engine']) {
	const log = vi.fn<(message: string) => void>()
	const scheduler = createScheduler({ engine, log })
	onTestFinished(() => {
		scheduler.close()
	})
	return { scheduler, log }
}

/** Fake timers with the clock at `now`, real ones again when the test ends. */
function useClockAt(now: string): void {
	vi.useFakeTimers({ now: new Date(now) })
	onTestFinished(() => {
		vi.useRealTimers()
	})
}

const tenAm = '2026-11-09T10:00:00.000Z'

describe('createScheduler', () => {
	test('skips a tick while the last run is going, and not while it waits to be restarted', async () => {
		// Arrange
		useClockAt(tenAm)
		const going = fakeEngine('paused')
		const restartable = fakeEngine('restartable')
		openScheduler(going.engine).scheduler.update(appVersion('v1'))
		openScheduler(restartable.engine).scheduler.update(appVersion('v1'))

		// Act
		await vi.advanceTimersByTimeAsync(3_000)

		// Assert
		expect(going.startRun).toHaveBeenCalledOnce()
		expect(restartable.startRun).toHaveBeenCalledTimes(3)
	})

	test('follows the schedules of the version deployed now, and none once a version lists none', async () => {
		// Arrange
		useClockAt(tenAm)
		const { engine, startRun } = fakeEngine('succeeded')
		const { scheduler } = openScheduler(engine)
		scheduler.update(appVersion('v1'))
		await vi.advanceTimersByTimeAsync(1_000)

		// Act
		scheduler.update(appVersion('v2', [everyOtherSecond]))
		await vi.advanceTimersByTimeAsync(2_000)
		scheduler.update(appVersion('v3', []))
		await vi.advanceTimersByTimeAsync(3_000)

		// Assert
		expect(startRun.mock.calls.map(([options]) => options.trigger.id)).toEqual(['report * * * * * *', 'report */2 * * * * *'])
	})

	test('disarms every schedule when it is given no version', async () => {
		// Arrange
		useClockAt(tenAm)
		const { engine, startRun } = fakeEngine('succeeded')
		const { scheduler } = openScheduler(engine)
		scheduler.update(appVersion('v1'))

		// Act
		scheduler.update(undefined)
		await vi.advanceTimersByTimeAsync(3_000)

		// Assert
		expect(startRun).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	test('does not make up for ticks it missed when the clock jumps', async () => {
		// Arrange
		useClockAt(tenAm)
		const { engine, startRun } = fakeEngine('succeeded')
		openScheduler(engine).scheduler.update(appVersion('v1'))

		// Act
		vi.setSystemTime(new Date('2026-11-09T11:00:00.000Z'))
		await vi.advanceTimersByTimeAsync(1_500)

		// Assert
		expect(startRun).toHaveBeenCalledTimes(1)
	})

	test('starts nothing once it is closed', async () => {
		// Arrange
		useClockAt(tenAm)
		const { engine, startRun } = fakeEngine('succeeded')
		const { scheduler } = openScheduler(engine)
		scheduler.update(appVersion('v1'))

		// Act
		scheduler.close()
		await vi.advanceTimersByTimeAsync(3_000)

		// Assert
		expect(startRun).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	test('arms nothing when it is given a version after it closed', async () => {
		// Arrange
		useClockAt(tenAm)
		const { engine, startRun } = fakeEngine('succeeded')
		const { scheduler } = openScheduler(engine)
		scheduler.close()

		// Act
		scheduler.update(appVersion('v1'))
		await vi.advanceTimersByTimeAsync(3_000)

		// Assert
		expect(vi.getTimerCount()).toBe(0)
		expect(startRun).not.toHaveBeenCalled()
	})
})
