import { type Repository } from '@mesh-flow/git'
import { cli } from './cli'

/** Updates package references to the given versions, e.g. `Company.Contracts@2.4.0`. No-op when empty. */
export function updatePackages(repository: Repository, packages: readonly string[]): Promise<void> {
	return packages.length === 0 ? Promise.resolve() : cli.updatePackages(repository, packages)
}
