import { setTimeout as delay } from 'node:timers/promises'
import type { TriggerDescription } from '@mesh-flow/protocol'
import { Cron } from 'croner'
import type { Engine } from '../engine/engine.mts'
import { settleWithin } from '../engine/settle-within.mts'
import { wakeAt } from '../engine/wake-at.mts'
import { messageOf } from '../errors.mts'
import type { Repository, RepositoryStore } from '../repositories/repository-store.mts'
import { finishedStatuses } from '../runs/run-record.mts'

type ScheduleDescription = Extract<TriggerDescription, { kind: 'schedule' }>

/** What the scheduler needs. */
export interface SchedulerOptions {
	readonly engine: Engine
	readonly repositories: RepositoryStore
	readonly log: (message: string) => void
	/** The wall clock. Default: the system clock. */
	readonly now?: () => Date
	/** How often the repositories' entry files are read again for changed schedules. Default: a minute. */
	readonly refreshMs?: number
}

/** Starts schedule runs on the wall clock, until it's closed. */
export interface Scheduler {
	/** Reads every registered repository's schedules again, such as after one was added. */
	refresh(): Promise<void>
	/** Stops every timer and waits, within `deadline`, for a refresh that's going on. */
	close(deadline: AbortSignal): Promise<void>
}

/** A schedule with its timer. */
interface Armed {
	readonly cron: string
	readonly controller: AbortController
}

const defaultRefreshMs = 60_000

/**
 * Runs the schedule triggers of every registered repository. The entry files are described again
 * every `refreshMs` (cached per source, so that's cheap when nothing changed), and a schedule's
 * timer follows its cron expression on the engine's clock.
 *
 * A tick is skipped while the previous run of the same schedule is still going, also when it's
 * paused or waits for a human. Ticks missed while the engine wasn't running aren't made up for.
 */
export function startScheduler(options: SchedulerOptions): Scheduler {
	const { engine, repositories, log } = options
	const now = options.now ?? (() => new Date())
	const lifetime = new AbortController()
	const armed = new Map<string, Armed>()
	/** Schedules whose run is being started, so a tick meanwhile is skipped too. */
	const starting = new Set<string>()
	/** The last problem reported per repository or schedule, so a broken entry file isn't reported every minute. */
	const reported = new Map<string, string>()

	const report = (subject: string, problem: string | undefined) => {
		if (problem === undefined) reported.delete(subject)
		else if (reported.get(subject) !== problem) {
			reported.set(subject, problem)
			log(problem)
		}
	}

	const tick = async (repository: Repository, schedule: ScheduleDescription, at: Date) => {
		const name = `${repository.name}/${schedule.id}`
		const going = engine
			.list()
			.find(
				(record) =>
					record.trigger?.kind === 'schedule' &&
					record.trigger.id === schedule.id &&
					record.trigger.repository === repository.name &&
					!finishedStatuses.has(record.status),
			)
		if (going !== undefined || starting.has(name)) {
			log(
				`Skipped schedule ${name} at ${at.toISOString()}: ${going ? `run ${going.id} is still ${going.status}` : 'its last run is still starting'}.`,
			)
			return
		}
		starting.add(name)
		try {
			await engine.startRun({
				directory: repository.directory,
				workflow: schedule.workflow,
				trigger: { kind: 'schedule', id: schedule.id, repository: repository.name },
				key: `schedule ${name}/${at.toISOString()}`,
				signal: lifetime.signal,
			})
		} catch (error) {
			if (!lifetime.signal.aborted) log(`Starting schedule ${name} at ${at.toISOString()} failed: ${messageOf(error)}`)
		} finally {
			starting.delete(name)
		}
	}

	const arm = (repository: Repository, schedule: ScheduleDescription, controller: AbortController) => {
		const name = `${repository.name}/${schedule.id}`
		let cron: Cron
		try {
			cron = new Cron(schedule.cron, { paused: true })
		} catch (error) {
			report(name, `Schedule ${name} doesn't run: ${messageOf(error)}`)
			return
		}
		report(name, undefined)
		const next = (after: Date) => {
			const at = cron.nextRun(after)
			if (at === null) return
			wakeAt(
				at,
				() => {
					next(at)
					void tick(repository, schedule, at)
				},
				controller.signal,
				now,
			)
		}
		next(now())
	}

	const refresh = async () => {
		const wanted = new Map<string, { repository: Repository; schedule: ScheduleDescription }>()
		const kept = new Set<string>()
		for (const repository of await repositories.list()) {
			try {
				const description = await engine.describe(repository.directory, lifetime.signal)
				report(repository.name, undefined)
				for (const trigger of description.triggers) {
					if (trigger.kind === 'schedule') wanted.set(`${repository.name}\0${trigger.id}`, { repository, schedule: trigger })
				}
			} catch (error) {
				if (lifetime.signal.aborted) return
				report(repository.name, `Reading the schedules of ${repository.name} failed, so they stay as they were: ${messageOf(error)}`)
				for (const key of armed.keys()) if (key.startsWith(`${repository.name}\0`)) kept.add(key)
			}
		}
		for (const [key, { controller, cron }] of armed) {
			if (kept.has(key) || wanted.get(key)?.schedule.cron === cron) continue
			controller.abort()
			armed.delete(key)
		}
		for (const [key, { repository, schedule }] of wanted) {
			if (armed.has(key)) continue
			const controller = new AbortController()
			lifetime.signal.addEventListener(
				'abort',
				() => {
					controller.abort()
				},
				{ once: true },
			)
			armed.set(key, { cron: schedule.cron, controller })
			arm(repository, schedule, controller)
		}
	}

	let refreshing = Promise.resolve()
	const refreshNow = () => {
		refreshing = refreshing.then(refresh).catch((error: unknown) => {
			if (!lifetime.signal.aborted) log(`Reading the schedules failed: ${messageOf(error)}`)
		})
		return refreshing
	}
	const loop = async () => {
		while (!lifetime.signal.aborted) {
			await refreshNow()
			await delay(options.refreshMs ?? defaultRefreshMs, undefined, { signal: lifetime.signal }).catch(() => undefined)
		}
	}
	const looping = loop()

	return Object.freeze({
		refresh: refreshNow,
		async close(deadline) {
			lifetime.abort(new Error('The scheduler is closing.'))
			await settleWithin(Promise.all([looping, refreshing]), deadline)
		},
	} satisfies Scheduler)
}
