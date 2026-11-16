import { filePathOf } from '../file-path.mts'

/** Where the checkouts go in the workspace, apart from the workflow's own folders, such as `research/`. */
const checkoutsFolder = 'repositories'

/**
 * The workspace folder of a repository's checkout: its whole name on the code host, in lower case
 * since code hosts ignore case in names, under `repositories/`. Two repositories never share one,
 * such as `team/backend/api` and `team/frontend/api`, and none lands in a folder of the workflow's.
 * A segment Windows can't take as a folder, such as `aux`, gets a `-` at the end, on every platform.
 */
export function checkoutFolder(repository: string): string {
	return `${checkoutsFolder}/${filePathOf(repository.toLowerCase())}`
}
