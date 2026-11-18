import { codeArtifact } from '@mesh-flow/aws'

/**
 * The team's private NuGet and npm packages, which a repository's `nuget.config` or `.npmrc` names by
 * their CodeArtifact URL. Placeholder values: name the team's own domain, account, region and
 * repository here.
 */
export const awsCodeArtifacts = codeArtifact({
	domain: 'example',
	owner: '123456789012',
	region: 'eu-west-1',
	repository: 'packages',
})
