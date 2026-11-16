import path from 'node:path'
import { keyFile, openCredentialStore, type CredentialStore, type LoginPrompt } from '@mesh-flow/gateway'
import { openAwsSession } from '../../src/host/aws-session.mts'
import { awsCredentialNames } from '../../src/host/aws-settings.mts'
import { refreshTokenGrant } from '../../src/host/oidc.mts'
import { signIn } from '../../src/host/sign-in.mts'
import { msPerMinute } from '../../src/host/time.mts'
import { fakeAws, type FakeAws, type FakeAwsState } from './fake-aws.mts'
import { temporaryDirectory } from './temporary-directory.mts'

export const abortSignal = new AbortController().signal

/** How long a call may take to settle once stopped, while AWS never answers. */
export const promptlyMs = 3_000

export const settings = {
	[awsCredentialNames.startUrl]: 'https://example.awsapps.com/start',
	[awsCredentialNames.ssoRegion]: 'eu-west-1',
	[awsCredentialNames.account]: '123456789012',
	[awsCredentialNames.role]: 'Developer',
}

export const domain = { domain: 'example', owner: '123456789012', region: 'eu-west-1' }

/** A clock a test moves on by hand, by minutes. */
function testClock() {
	let current = new Date('2026-11-16T09:00:00.000Z')
	return {
		now: () => current,
		advance: (minutes: number) => {
			current = new Date(current.getTime() + minutes * msPerMinute)
		},
	}
}

/** What {@link setUp} takes. */
export interface SetUpOptions {
	/** How the fake AWS behaves from the start. */
	readonly fake?: Partial<FakeAwsState>
	/** Whether the AWS settings are in the credential store. Default: they are. */
	readonly settings?: boolean
}

/** A credential store with the AWS settings in, a fake AWS, and a clock. */
export async function setUp(options: SetUpOptions = {}) {
	const home = await temporaryDirectory()
	const credentials = openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
	if (options.settings ?? true) for (const [name, value] of Object.entries(settings)) await credentials.set(name, value, abortSignal)
	const clock = testClock()
	const aws = await fakeAws(clock.now, options.fake)
	const shown: LoginPrompt[] = []
	const waited: number[] = []
	const login = () =>
		signIn(
			{ credentials, show: (prompt) => shown.push(prompt), abortSignal },
			{
				endpoints: aws.endpoints,
				now: clock.now,
				wait: (ms) => {
					waited.push(ms)
					return Promise.resolve()
				},
			},
		)
	const session = () => openAwsSession({ credentials, endpoints: aws.endpoints, now: clock.now })
	return { credentials, clock, aws, shown, waited, login, session }
}

/** The session as the credential store keeps it. */
export async function storedSession(credentials: CredentialStore): Promise<unknown> {
	return JSON.parse((await credentials.get(awsCredentialNames.session, abortSignal)) ?? 'null')
}

/** Holds Identity Center's answers to refreshes until `release` is called. */
export function holdRefreshes(aws: FakeAws): { readonly release: () => void } {
	const answer = Promise.withResolvers<undefined>()
	aws.state.hold = (_requested, grantType) => (grantType === refreshTokenGrant ? answer.promise : Promise.resolve())
	return {
		release: () => {
			answer.resolve(undefined)
		},
	}
}
