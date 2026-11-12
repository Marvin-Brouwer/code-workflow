import path from 'node:path'
import { toPosix } from './to-posix.mts'

/** The folder a package manager installs packages in. */
const packagesFolder = 'node_modules'

/** pnpm's store inside `node_modules`: `.pnpm/<package and its peers' versions>/node_modules/`. */
const pnpmStore = '.pnpm'

/**
 * A source file as the app's source map names it: relative to the repository (`root`, with its
 * links resolved, as the bundler sees files), with `/`. An installed package is named from its
 * package name on (`@mesh-flow/github/dist/github.mjs`), so where the package manager keeps it,
 * such as pnpm's folder with the versions of its peers, doesn't count. A package installed inside
 * another keeps that one in its name (`a/node_modules/b/index.js`).
 */
export function sourceName(root: string, file: string): string {
	const segments = toPosix(path.relative(root, file)).split('/')
	const installed = segments.indexOf(packagesFolder)
	if (installed === -1) return segments.join('/')
	const inPackage = segments.slice(installed + 1)
	const inStore = inPackage[0] === pnpmStore && inPackage[2] === packagesFolder
	return (inStore ? inPackage.slice(3) : inPackage).join('/')
}
