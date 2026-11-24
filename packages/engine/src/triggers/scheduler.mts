import type { TriggerDescription } from '@mesh-flow/protocol'
import { Cron } from 'croner'
import type { AppVersion } from '../app/deployment.mts'
import { startRunTimeout, type Engine } from '../engine/engine.mts'
import { wakeAt } from '../engine/wake-at.mts'
import { messageOf } from '../errors.mts'
import type { RunStatus } from '../runs/run-record.mts'

type ScheduleDescription = Extract<TriggerDescription, { kind: 'schedule' }>

/** What the scheduler needs. */
export interface SchedulerOptions {
	readonly engine: Pick<Engine, 'list' | 'startRun'>
	readonly log: (message: string) => void
	/** The wall clock. Default: the system clock. */
	readonly now?: () => Date
}

/** Starts schedule runs on the wall clock, for the schedules it was last given. */
export interface Scheduler {
	/** Follows this app version's schedules from now on: new ones are armed, changed or gone ones disarmed. */
	update(app: AppVersion | undefined): void
	/** Stops every timer, and arms none from then on. Runs that were started go on. */
	close(): void
}

/** A schedule with its timer, and the app version it was armed for. */
interface Armed {
	readonly version: string
	readonly controller: AbortController
}

/**
 * Statuses of a schedule's run during which its next tick is skipped. A run that is `restartable`
 * needs a person, so it doesn't hold its schedule up; a `paused` one is still going, and does.
 */
const goingStatuses: ReadonlySet<RunStatus> = new Set(['starting', 'running', 'paused'])

/**
 * Starts the schedule triggers of the app version it's given, each on its cron expression and the
 * engine's clock. A tick is skipped while the previous run of the same schedule is still going.
 * Ticks missed while the engine wasn't running, or while the machine slept, aren't made up for.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
	const { engine, log } = options
	const now = options.now ?? (() => new Date())
	const armed = new Map<string, Armed>()
	let closed = false
	/** Schedules whose run is being started, so a tick meanwhile is skipped too. */
	const starting = new Set<string>()
	/** Schedules whose cron expression was reported as broken, so it's reported once. */
	const broken = new Set<string>()

	const tick = async (schedule: ScheduleDescription, at: Date, abortSignal: AbortSignal) => {
		const going = engine
			.list()
			.find((record) => record.trigger.kind === 'schedule' && record.trigger.id === schedule.id && goingStatuses.has(record.status))
		if (going !== undefined || starting.has(schedule.id)) {
			const why = going === undefined ? 'its last run is still starting' : `run ${going.id} is still ${going.status}`
			log(`Skipped schedule ${schedule.id} at ${at.toISOString()}: ${why}.`)
			return
		}
		starting.add(schedule.id)
		try {
			await engine.startRun({
				trigger: { kind: 'schedule', id: schedule.id },
				key: `schedule ${schedule.id}/${at.toISOString()}`,
				abortSignal: startRunTimeout.toAbortSignal(),
			})
		} catch (error) {
			// Disarmed meanwhile, as on shutdown: the engine turning the run down is expected then.
			if (!abortSignal.aborted) log(`Starting schedule ${schedule.id} at ${at.toISOString()} failed: ${messageOf(error)}`)
		} finally {
			starting.delete(schedule.id)
		}
	}

	const arm = (schedule: ScheduleDescription, abortSignal: AbortSignal) => {
		let cron: Cron
		try {
			cron = new Cron(schedule.cron, { paused: true })
		} catch (error) {
			if (!broken.has(schedule.id)) log(`Schedule ${schedule.id} doesn't run: ${messageOf(error)}`)
			broken.add(schedule.id)
			return
		}
		broken.delete(schedule.id)
		const next = (after: Date) => {
			const at = cron.nextRun(after)
			if (at === null) return
			const fire = () => {
				// From now, not from the tick: a timer that fired late, after a sleep, doesn't make up for what it missed.
				next(new Date(Math.max(at.getTime(), now().getTime())))
				void tick(schedule, at, abortSignal)
			}
			wakeAt(at, fire, abortSignal, now)
		}
		next(now())
	}

	return Object.freeze({
		update(app) {
			if (closed) return
			const schedules = (app?.manifest.description.triggers ?? []).filter(
				(trigger): trigger is ScheduleDescription => trigger.kind === 'schedule',
			)
			for (const [name, current] of armed) {
				// A new version may have changed the schedule's workflow or parameters: armed again.
				if (app?.version === current.version && schedules.some((schedule) => schedule.id === name)) continue
				current.controller.abort()
				armed.delete(name)
			}
			if (app === undefined) return
			for (const schedule of schedules) {
				if (armed.has(schedule.id)) continue
				const controller = new AbortController()
				armed.set(schedule.id, { version: app.version, controller })
				arm(schedule, controller.signal)
			}
		},
		close() {
			closed = true
			for (const { controller } of armed.values()) controller.abort()
			armed.clear()
		},
	} satisfies Scheduler)
}
