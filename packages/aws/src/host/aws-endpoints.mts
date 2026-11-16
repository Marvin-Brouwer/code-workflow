/**
 * Where the AWS clients send their requests, for a test against fakes of its own. Each one left out
 * is AWS's own endpoint for the region.
 */
export interface AwsEndpoints {
	/** Identity Center's OIDC service: client registration, device authorization and tokens. */
	readonly oidc?: string
	/** The access portal's API, which hands out role credentials. */
	readonly sso?: string
	/** CodeArtifact, which hands out authorization tokens. */
	readonly codeArtifact?: string
}
