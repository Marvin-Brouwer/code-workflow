/**
 * The team's CodeArtifact repositories the sandbox restores from. Placeholder values: name the
 * team's own domain, account, region and repository here.
 */
import { codeArtifact } from '@mesh-flow/aws'

/** The team's private NuGet packages, which a repository's `nuget.config` names by their CodeArtifact URL. */
const teamPackages = codeArtifact({
	domain: 'example',
	owner: '123456789012',
	region: 'eu-west-1',
	repository: 'packages',
})

export const awsCodeArtifacts = [teamPackages]
