import { setTimeout as delay } from 'node:timers/promises'
import type { WorkflowsDescription } from '@mesh-flow/protocol'
import type { Engine } from '../engine/engine.mts'
import { settleWithin } from '../engine/settle-within.mts'
import { messageOf } from '../errors.mts'
import type { Repository, RepositoryStore } from '../repositories/repository-store.mts'

/** A registered repository and what its entry file declared the last time it could be described. */
export interface DescribedRepository {
	readonly repository: Repository
	readonly description: WorkflowsDescription
}

/** What the repository watch needs. */
export interface RepositoryWatchOptions {
	readonly engine: Pick<Engine, 'describe'>
	readonly repositories: RepositoryStore
	readonly log: (message: string) => void
	/** How often every repository is described again. Default: a minute. */
	readonly refreshMs?: number
	/** Called after every refresh with every repository that has a description. */
	readonly refreshed: (described: readonly DescribedRepository[]) => void
}

/** The last description of every registered repository, kept fresh in the background. */
export interface RepositoryWatch {
	/** The last description of the repository called `name`, if it was ever described. */
	readonly described: (name: string) => DescribedRepository | undefined
	/** Describes every repository again now, such as after one was added. */
	refresh(): Promise<void>
	/** Stops refreshing, and waits within `deadlineSignal` for a refresh that's going on. */
	close(deadlineSignal: AbortSignal): Promise<void>
}

const defaultRefreshMs = 60_000

/**
 * Describes every registered repository's entry file, now and every `refreshMs`, so webhooks and
 * schedules always have a description to go by without describing on a delivery's request.
 * Describing is cached per version of the source, so a refresh is cheap when nothing changed. A
 * repository that can't be described keeps its last description, and the problem is reported once.
 */
export function watchRepositories(options: RepositoryWatchOptions): RepositoryWatch {
	const { engine, repositories, log } = options
	const lifetime = new AbortController()
	const described = new Map<string, DescribedRepository>()
	/** The last problem reported per repository, so a broken entry file isn't reported every minute. */
	const reported = new Map<string, string>()

	const refresh = async () => {
		const registered = await repositories.list()
		for (const name of described.keys()) {
			if (!registered.some((repository) => repository.name === name)) described.delete(name)
		}
		for (const repository of registered) {
			try {
				const description = await engine.describe(repository.directory, lifetime.signal)
				described.set(repository.name, { repository, description })
				reported.delete(repository.name)
			} catch (error) {
				if (lifetime.signal.aborted) return
				const problem = `Describing ${repository.name} failed, so its triggers stay as they were: ${messageOf(error)}`
				if (reported.get(repository.name) !== problem) log(problem)
				reported.set(repository.name, problem)
				const known = described.get(repository.name)
				// Pointed at another directory: the old one's description is kept, the new directory with it.
				if (known !== undefined) described.set(repository.name, { ...known, repository })
			}
		}
		options.refreshed([...described.values()])
	}

	let refreshing = Promise.resolve()
	const refreshNow = () => {
		refreshing = refreshing.then(refresh).catch((error: unknown) => {
			if (!lifetime.signal.aborted) log(`Reading the registered repositories failed: ${messageOf(error)}`)
		})
		return refreshing
	}
	const looping = (async () => {
		while (!lifetime.signal.aborted) {
			await refreshNow()
			await delay(options.refreshMs ?? defaultRefreshMs, undefined, { signal: lifetime.signal }).catch(() => undefined)
		}
	})()

	return Object.freeze({
		described: (name) => described.get(name),
		refresh: refreshNow,
		async close(deadlineSignal) {
			lifetime.abort(new Error('The repository watch is closing.'))
			await settleWithin(Promise.all([looping, refreshing]), deadlineSignal)
		},
	} satisfies RepositoryWatch)
}
