/**
 * The team's private NuGet packages, which a repository's `nuget.config` names by their CodeArtifact
 * URL. Placeholder values: name the team's own domain, account, region and repository here.
 */
import { codeArtifact } from '@mesh-flow/aws'

export const awsCodeArtifacts = codeArtifact({
	domain: 'example',
	owner: '123456789012',
	region: 'eu-west-1',
	repository: 'packages',
})
