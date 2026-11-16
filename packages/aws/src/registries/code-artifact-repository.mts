import { z } from 'zod'

/** A CodeArtifact repository: its domain, the account that owns the domain, the domain's region, and the repository's name. */
export const CodeArtifactRepository = z.object({
	domain: z.string().regex(/^[a-z][a-z0-9-]{0,48}[a-z0-9]$/, 'Use a CodeArtifact domain name, such as example.'),
	owner: z.string().regex(/^\d{12}$/, 'Use the 12-digit account that owns the domain.'),
	region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/, 'Use an AWS region, such as eu-west-1.'),
	repository: z.string().regex(/^[A-Za-z0-9][\w.-]{1,99}$/, 'Use a CodeArtifact repository name, such as packages.'),
})
export type CodeArtifactRepository = z.infer<typeof CodeArtifactRepository>

/** The package formats a repository serves to the package managers the sandbox restores with. */
export const codeArtifactFormats = ['nuget', 'npm'] as const

/** The host a CodeArtifact domain's repositories are on, as `aws codeartifact login` points package managers at it. */
export function codeArtifactHost({ domain, owner, region }: Omit<CodeArtifactRepository, 'repository'>): string {
	return `${domain}-${owner}.d.codeartifact.${region}.amazonaws.com`
}

/** A package format a repository serves. */
export type CodeArtifactFormat = (typeof codeArtifactFormats)[number]

/** The repository's path on its host for one format, such as `/nuget/packages/`. */
export function codeArtifactPath(format: CodeArtifactFormat, repository: string): string {
	return `/${format}/${repository}/`
}

/** The repository's paths on its host: one for each format. */
export function codeArtifactPaths({ repository }: Pick<CodeArtifactRepository, 'repository'>): string[] {
	return codeArtifactFormats.map((format) => codeArtifactPath(format, repository))
}
