import path from 'node:path'
import { z } from 'zod'

/** A directory an agent names, as checkouts render in prompts: an absolute path. */
export const Directory = z
	.string()
	.refine((directory) => path.isAbsolute(directory), 'Use the absolute path of the checkout, as the prompt shows it.')
	.describe('The absolute path of the checkout, or of a project or solution in it')

/** A solution or project file, which `dotnet` takes in place of a directory. */
const projectFile = /\.(sln|slnx|slnf|csproj|fsproj|vbproj|proj)$/i

/** Where `dotnet` runs for a target: the directory itself, or the one a solution or project file is in. */
export function workingDirectoryOf(target: string): string {
	return projectFile.test(target) ? path.dirname(target) : target
}
