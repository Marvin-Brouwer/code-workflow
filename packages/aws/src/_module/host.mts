/**
 * The host half of the AWS connector: the IAM Identity Center session, and the role credentials
 * and CodeArtifact tokens the host derives from it. None of it ever enters the sandbox.
 *
 * @module
 */
export { type AwsEndpoints } from '../host/aws-endpoints.mts'
export {
	openAwsSession,
	type AwsSession,
	type AwsSessionOptions,
	type AwsSessionStatus,
	type CodeArtifactDomain,
	type CodeArtifactToken,
	type RoleCredentials,
} from '../host/aws-session.mts'
export { awsCredentialNames, readAwsSettings, type AwsSettings } from '../host/aws-settings.mts'
export { connector } from '../host/connector.mts'
export { signIn, type SignInOptions } from '../host/sign-in.mts'
export { AwsSignInNeeded, isSignInNeeded } from '../host/sign-in-needed.mts'
