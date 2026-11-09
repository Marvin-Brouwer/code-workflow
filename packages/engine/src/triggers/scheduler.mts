import type { TriggerDescription } from '@mesh-flow/protocol'
import { Cron } from 'croner'
import { startRunTimeoutMs, type Engine } from '../engine/engine.mts'
import { wakeAt } from '../engine/wake-at.mts'
import { messageOf } from '../errors.mts'
import type { AppVersion } from '../apps/app-store.mts'
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
	/** Follows these apps' schedules from now on: new ones are armed, changed or gone ones disarmed. */
	update(apps: readonly AppVersion[]): void
	/** Stops every timer. Runs that were started go on. */
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

/** Names a schedule of an app, in run keys and logs. */
function scheduleName(app: string, schedule: string): string {
	return `${app}/${schedule}`
}

/**
 * Starts the schedule triggers of the apps it's given, each on its cron expression and the
 * engine's clock. A tick is skipped while the previous run of the same schedule is still going.
 * Ticks missed while the engine wasn't running, or while the machine slept, aren't made up for.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
	const { engine, log } = options
	const now = options.now ?? (() => new Date())
	const armed = new Map<string, Armed>()
	/** Schedules whose run is being started, so a tick meanwhile is skipped too. */
	const starting = new Set<string>()
	/** Schedules whose cron expression was reported as broken, so it's reported once. */
	const broken = new Set<string>()

	const tick = async (app: string, schedule: ScheduleDescription, at: Date, abortSignal: AbortSignal) => {
		const name = scheduleName(app, schedule.id)
		const going = engine
			.list()
			.find(
				(record) =>
					record.trigger.kind === 'schedule' &&
					record.trigger.id === schedule.id &&
					record.app.name === app &&
					goingStatuses.has(record.status),
			)
		if (going !== undefined || starting.has(name)) {
			const why = going === undefined ? 'its last run is still starting' : `run ${going.id} is still ${going.status}`
			log(`Skipped schedule ${name} at ${at.toISOString()}: ${why}.`)
			return
		}
		starting.add(name)
		try {
			await engine.startRun({
				app,
				trigger: { kind: 'schedule', id: schedule.id },
				key: `schedule ${name}/${at.toISOString()}`,
				abortSignal: AbortSignal.timeout(startRunTimeoutMs),
			})
		} catch (error) {
			// Disarmed meanwhile, as on shutdown: the engine turning the run down is expected then.
			if (!abortSignal.aborted) log(`Starting schedule ${name} at ${at.toISOString()} failed: ${messageOf(error)}`)
		} finally {
			starting.delete(name)
		}
	}

	const arm = (app: string, schedule: ScheduleDescription, abortSignal: AbortSignal) => {
		const name = scheduleName(app, schedule.id)
		let cron: Cron
		try {
			cron = new Cron(schedule.cron, { paused: true })
		} catch (error) {
			if (!broken.has(name)) log(`Schedule ${name} doesn't run: ${messageOf(error)}`)
			broken.add(name)
			return
		}
		broken.delete(name)
		const next = (after: Date) => {
			const at = cron.nextRun(after)
			if (at === null) return
			const fire = () => {
				// From now, not from the tick: a timer that fired late, after a sleep, doesn't make up for what it missed.
				next(new Date(Math.max(at.getTime(), now().getTime())))
				void tick(app, schedule, at, abortSignal)
			}
			wakeAt(at, fire, abortSignal, now)
		}
		next(now())
	}

	return Object.freeze({
		update(apps) {
			const wanted = new Map<string, { app: AppVersion; schedule: ScheduleDescription }>()
			for (const app of apps) {
				for (const trigger of app.manifest.description.triggers) {
					if (trigger.kind === 'schedule') wanted.set(scheduleName(app.name, trigger.id), { app, schedule: trigger })
				}
			}
			for (const [name, current] of armed) {
				// A new version may have changed the schedule's workflow or parameters: armed again.
				if (wanted.get(name)?.app.version === current.version) continue
				current.controller.abort()
				armed.delete(name)
			}
			for (const [name, { app, schedule }] of wanted) {
				if (armed.has(name)) continue
				const controller = new AbortController()
				armed.set(name, { version: app.version, controller })
				arm(app.name, schedule, controller.signal)
			}
		},
		close() {
			for (const { controller } of armed.values()) controller.abort()
			armed.clear()
		},
	} satisfies Scheduler)
}
