import path from 'node:path'
import { keyFile, openCredentialStore, signInOf, type HostToolContext } from '@mesh-flow/gateway'
import { describe, expect, test } from 'vitest'
import { awsHostTools } from '../src/host/aws-host-tools.mts'
import { openAwsSession } from '../src/host/aws-session.mts'
import { awsCredentialNames } from '../src/host/aws-settings.mts'
import { signIn } from '../src/host/sign-in.mts'
import { checkSession } from '../src/tools/check-session.mts'
import { fakeAws } from './support/fake-aws.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal
const now = () => new Date('2026-11-16T09:00:00.000Z')

const settings = {
	[awsCredentialNames.startUrl]: 'https://example.awsapps.com/start',
	[awsCredentialNames.ssoRegion]: 'eu-west-1',
	[awsCredentialNames.account]: '123456789012',
	[awsCredentialNames.role]: 'Developer',
}

/** The AWS host tools on a fake AWS, by name, and how to sign in to it. */
async function setUp() {
	const home = await temporaryDirectory()
	const credentials = openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
	for (const [name, value] of Object.entries(settings)) await credentials.set(name, value, abortSignal)
	const aws = await fakeAws(now, {})
	const tools = new Map(awsHostTools(openAwsSession({ credentials, endpoints: aws.endpoints, now })).map((tool) => [tool.name, tool]))
	const context: HostToolContext = { abortSignal, credentials, runId: 'run-1' }
	const signInUser = () =>
		signIn({ credentials, show: () => undefined, abortSignal }, { endpoints: aws.endpoints, now, wait: () => Promise.resolve() })
	return { tools, context, signInUser }
}

describe('AWS host tools', () => {
	test('checkSession says the user has to sign in to aws, so the run waits for it', async () => {
		// Arrange
		const { tools, context } = await setUp()

		// Act
		const checking = tools.get(checkSession.name)?.run({}, context)

		// Assert
		const error: unknown = await checking?.catch((caught: unknown) => caught)
		expect(signInOf(error)).toBe('aws')
	})

	test('checkSession answers once there is a session', async () => {
		// Arrange
		const { tools, context, signInUser } = await setUp()
		await signInUser()

		// Act
		const checked = await tools.get(checkSession.name)?.run({}, context)

		// Assert
		expect(checkSession.output.parse(checked)).toEqual({ signedIn: true })
	})
})
