import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import writeFileAtomic from 'write-file-atomic'
import { hasErrorCode } from '../errors.mts'
import { kebabNamePattern } from '../workflow/workflow-name.mts'

/** A repository's name: it goes into webhook URLs and run keys. */
export const RepositoryName = z.string().regex(kebabNamePattern, 'A repository name is lowercase letters, digits and dashes.')

/**
 * A workflow repository the engine serves triggers for: its webhooks get a URL, its schedules run.
 * A repository that isn't registered can still run workflows from the CLI.
 */
export const Repository = z.object({ name: RepositoryName, directory: z.string().min(1) })
export type Repository = z.infer<typeof Repository>

const Repositories = z.array(Repository)

/** The registered repositories, in a JSON file in the engine's home. */
export interface RepositoryStore {
	list(): Promise<Repository[]>
	get(name: string): Promise<Repository | undefined>
	/** Registers a repository, or points a registered name at another directory. */
	add(repository: Repository): Promise<void>
	/** Whether there was a repository with this name. */
	remove(name: string): Promise<boolean>
}

/** The repositories in `file`. Writes happen one after another. */
export function openRepositoryStore(file: string): RepositoryStore {
	let writing = Promise.resolve()
	const read = async (): Promise<Repository[]> => {
		const text = await readFile(file, 'utf8').catch((error: unknown) => {
			if (hasErrorCode(error, 'ENOENT')) return '[]'
			throw error
		})
		return Repositories.parse(JSON.parse(text))
	}
	const change = (update: (repositories: Repository[]) => Repository[]): Promise<void> => {
		const next = writing.then(async () => {
			await writeFileAtomic(file, `${JSON.stringify(update(await read()), null, '\t')}\n`)
		})
		writing = next.catch(() => undefined)
		return next
	}
	return Object.freeze({
		list: read,
		get: async (name) => (await read()).find((repository) => repository.name === name),
		add: (repository) => change((repositories) => [...repositories.filter((known) => known.name !== repository.name), repository]),
		async remove(name) {
			const known = (await read()).some((repository) => repository.name === name)
			if (known) await change((repositories) => repositories.filter((repository) => repository.name !== name))
			return known
		},
	} satisfies RepositoryStore)
}
