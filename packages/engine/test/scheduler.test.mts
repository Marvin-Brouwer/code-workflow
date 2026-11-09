import type { TriggerDescription } from '@mesh-flow/protocol'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import type { AppVersion } from '../src/apps/app-store.mts'
import type { StartRunOptions } from '../src/engine/engine.mts'
import type { RunRecord, RunStatus } from '../src/runs/run-record.mts'
import { createScheduler } from '../src/triggers/scheduler.mts'

const sandbox = { image: 'host', cpus: 1, memoryMb: 512, egress: { allow: [] } }
const everySecond = { kind: 'schedule' as const, id: 'report * * * * * *', workflow: 'report', cron: '* * * * * *' }
const everyOtherSecond = { kind: 'schedule' as const, id: 'report */2 * * * * *', workflow: 'report', cron: '*/2 * * * * *' }

/** Version `version` of the app `team`, listing `triggers`. */
function teamApp(version: string, triggers: TriggerDescription[] = [everySecond]): AppVersion {
	return {
		name: 'team',
		version,
		manifest: {
			entry: 'main.mjs',
			platform: { os: 'linux', cpu: 'x64' },
			description: { sandbox, workflows: [{ name: 'report', parameters: { type: 'object' } }], triggers, tools: [], models: [] },
			builtAt: '2026-11-09T09:00:00.000Z',
		},
		tarball: `/apps/team/${version}/app.tgz`,
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
			app: { name: options.app, version: 'v1', entry: 'main.mjs', sandbox, tools: [] },
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
		openScheduler(going.engine).scheduler.update([teamApp('v1')])
		openScheduler(restartable.engine).scheduler.update([teamApp('v1')])

		// Act
		await vi.advanceTimersByTimeAsync(3_000)

		// Assert
		expect(going.startRun).toHaveBeenCalledOnce()
		expect(restartable.startRun).toHaveBeenCalledTimes(3)
	})

	test('follows the schedules of the version deployed now, and none once the app is gone', async () => {
		// Arrange
		useClockAt(tenAm)
		const { engine, startRun } = fakeEngine('succeeded')
		const { scheduler } = openScheduler(engine)
		scheduler.update([teamApp('v1')])
		await vi.advanceTimersByTimeAsync(1_000)

		// Act
		scheduler.update([teamApp('v2', [everyOtherSecond])])
		await vi.advanceTimersByTimeAsync(2_000)
		scheduler.update([])
		await vi.advanceTimersByTimeAsync(3_000)

		// Assert
		expect(startRun.mock.calls.map(([options]) => options.trigger.id)).toEqual(['report * * * * * *', 'report */2 * * * * *'])
	})

	test('does not make up for ticks it missed when the clock jumps', async () => {
		// Arrange
		useClockAt(tenAm)
		const { engine, startRun } = fakeEngine('succeeded')
		openScheduler(engine).scheduler.update([teamApp('v1')])

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
		scheduler.update([teamApp('v1')])

		// Act
		scheduler.close()
		await vi.advanceTimersByTimeAsync(3_000)

		// Assert
		expect(startRun).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	test('arms nothing when it is given apps after it closed', async () => {
		// Arrange
		useClockAt(tenAm)
		const { engine, startRun } = fakeEngine('succeeded')
		const { scheduler } = openScheduler(engine)
		scheduler.close()

		// Act
		scheduler.update([teamApp('v1')])
		await vi.advanceTimersByTimeAsync(3_000)

		// Assert
		expect(vi.getTimerCount()).toBe(0)
		expect(startRun).not.toHaveBeenCalled()
	})
})
