import path from 'node:path'
import {
	connectorCredentials,
	keyFile,
	openCredentialStore,
	openGateway,
	openProviderSettings,
	type CredentialStore,
	type Gateway,
} from '@mesh-flow/gateway'
import type { CallAnswer, ConnectorRegistry, RunGrant } from '@mesh-flow/protocol'
import { describe, expect, test } from 'vitest'
import { codeArtifact } from '../src/code-artifact.mts'
import { awsCredentialNames } from '../src/host/aws-settings.mts'
import { awsConnectorHost } from '../src/host/connector.mts'
import { fakeAws } from './support/fake-aws.mts'
import { fakeCodeArtifact, repositoryHost, signedDownload } from './support/fake-code-artifact.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal
const now = () => new Date('2026-11-16T09:00:00.000Z')
const runId = 'run-1'

const settings = {
	[awsCredentialNames.startUrl]: 'https://example.awsapps.com/start',
	[awsCredentialNames.ssoRegion]: 'eu-west-1',
	[awsCredentialNames.account]: '123456789012',
	[awsCredentialNames.role]: 'Developer',
}

const packages = codeArtifact({ domain: 'example', owner: '123456789012', region: 'eu-west-1', repository: 'packages' })

/**
 * A gateway whose AWS connector restores from a fake CodeArtifact, on a fake AWS, and a run that
 * restores from `registry`. `signedIn` signs in first; `configured` sets the AWS settings.
 */
async function setUp({
	signedIn = true,
	configured = true,
	registry = packages,
}: { signedIn?: boolean; configured?: boolean; registry?: ConnectorRegistry } = {}) {
	const home = await temporaryDirectory()
	const store = openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
	if (configured) for (const [name, value] of Object.entries(settings)) await store.set(name, value, abortSignal)
	const credentials = connectorCredentials(store, 'aws')
	const aws = await fakeAws(now, {})
	const host = awsConnectorHost({ endpoints: aws.endpoints, now, wait: () => Promise.resolve() })
	if (signedIn) await host.login?.({ credentials, show: () => undefined, abortSignal })
	const resolve = host.registries?.({ directory: home, credentials })
	if (resolve === undefined) throw new Error('The AWS connector has no registries.')
	const repository = fakeCodeArtifact()
	const gateway = openGateway({
		home: path.join(home, 'gateway'),
		credentials: store,
		providers: openProviderSettings(path.join(home, 'providers.json')),
		registries: { aws: resolve },
		fetch: repository.fetch,
	})
	const grant = await gateway.openRun(runId, { tools: [], registries: [registry] }, abortSignal)
	return {
		gateway,
		fetchPath: fetcher(gateway, grant, registry),
		repository,
		aws,
		host,
		credentials: credentials satisfies CredentialStore,
	}
}

/** Fetches paths on `registry`, each call on the next token: an answer hands out the next. */
function fetcher(gateway: Gateway, grant: RunGrant, registry: ConnectorRegistry) {
	if (grant.packages === undefined) throw new Error('The run has no package endpoint.')
	const { endpoint } = grant.packages
	const tokens = [...grant.packages.tokens]
	let calls = 0
	return async (fetchPath: string) => {
		const id = `call-${String(++calls)}`
		const token = tokens.shift() ?? ''
		const accepted = await gateway.accept(
			runId,
			{ type: 'call', id, endpoint, token, call: { type: 'package', request: { registry, path: fetchPath } } },
			abortSignal,
		)
		const answer: CallAnswer = await accepted.answer(abortSignal)
		await gateway.settle(runId, id, abortSignal)
		if (answer.next !== undefined) tokens.push(answer.next)
		return { outcome: answer.outcome, body: accepted.body()?.toString('utf8') }
	}
}

describe('codeArtifact', () => {
	test("is the repository's registry: on its domain's host, below its npm and NuGet paths", () => {
		// Assert
		expect(packages).toEqual({
			connector: 'aws',
			name: 'codeartifact example/packages',
			host: repositoryHost,
			paths: ['/nuget/packages/', '/npm/packages/'],
			settings: { domain: 'example', owner: '123456789012', region: 'eu-west-1', repository: 'packages' },
		})
	})

	test.each([
		{ domain: 'Example', owner: '123456789012', region: 'eu-west-1', repository: 'packages' },
		{ domain: 'example', owner: '1234', region: 'eu-west-1', repository: 'packages' },
		{ domain: 'example', owner: '123456789012', region: 'evil.example/', repository: 'packages' },
		{ domain: 'example', owner: '123456789012', region: 'eu-west-1', repository: '../packages' },
	])('refuses %o, which is no CodeArtifact repository', (repository) => {
		// Act
		const describing = () => codeArtifact(repository)

		// Assert
		expect(describing).toThrow()
	})
})

describe('restoring from CodeArtifact', () => {
	test('fetches npm packages with a bearer token, and a tarball from its signed download without it', async () => {
		// Arrange
		const { fetchPath, repository, aws } = await setUp()

		// Act
		const document = await fetchPath('/npm/packages/left-pad')
		const tarball = await fetchPath('/npm/packages/left-pad/-/left-pad-1.3.0.tgz')

		// Assert
		expect([document.outcome.ok, tarball.outcome.ok]).toEqual([true, true])
		expect(JSON.parse(document.body ?? '')).toMatchObject({ name: 'left-pad' })
		expect(tarball.body).toBe('tarball')
		expect(repository.requests).toEqual([
			expect.stringMatching(new RegExp(`^https://${repositoryHost}/npm/packages/left-pad Bearer codeartifact-example-\\d+$`)),
			expect.stringMatching(/left-pad-1\.3\.0\.tgz Bearer /),
			`${signedDownload} `,
		])
		expect(aws.requests).toContain('POST /v1/authorization-token')
	})

	test('fetches NuGet packages with the token as the password of the user aws', async () => {
		// Arrange
		const { fetchPath, repository } = await setUp()

		// Act
		const index = await fetchPath('/nuget/packages/v3/index.json')
		const versions = await fetchPath('/nuget/packages/v3/package/example.only/index.json')
		const nupkg = await fetchPath('/nuget/packages/v3/package/example.only/1.0.0/example.only.1.0.0.nupkg')

		// Assert
		expect([index, versions, nupkg].map(({ outcome }) => outcome)).toEqual([
			expect.objectContaining({ result: expect.objectContaining({ status: 200 }) as unknown }),
			expect.objectContaining({ result: expect.objectContaining({ status: 200 }) as unknown }),
			expect.objectContaining({ result: expect.objectContaining({ status: 200 }) as unknown }),
		])
		expect(nupkg.body).toBe('nupkg')
		expect(repository.requests.every((request) => request.includes(' Basic '))).toBe(true)
	})

	test('keeps a package it fetched whole and fetches it only once', async () => {
		// Arrange
		const { fetchPath, repository } = await setUp()
		const nupkg = '/nuget/packages/v3/package/example.only/1.0.0/example.only.1.0.0.nupkg'
		await fetchPath(nupkg)

		// Act
		const again = await fetchPath(nupkg)

		// Assert
		expect(again.body).toBe('nupkg')
		expect(repository.requests).toHaveLength(1)
	})

	test('makes the run sign in to AWS first when there is no session, and fetches nothing', async () => {
		// Arrange
		const { fetchPath, repository } = await setUp({ signedIn: false })

		// Act
		const { outcome } = await fetchPath('/npm/packages/left-pad')

		// Assert
		expect(outcome).toMatchObject({ ok: false, signInTo: 'aws' })
		expect(repository.requests).toEqual([])
	})

	test("refuses a registry that names another host than its domain's, and sends the token nowhere", async () => {
		// Arrange
		const elsewhere = { ...packages, host: 'packages.evil.example' }
		const { fetchPath, repository, aws } = await setUp({ registry: elsewhere })

		// Act
		const { outcome } = await fetchPath('/npm/packages/left-pad')

		// Assert
		expect(outcome).toMatchObject({
			ok: false,
			error: expect.stringContaining(`is on ${repositoryHost}, not packages.evil.example`) as unknown,
		})
		expect(repository.requests).toEqual([])
		expect(aws.requests).not.toContain('POST /v1/authorization-token')
	})

	test('says which AWS settings are missing, for deploy and trigger, and nothing once they are set', async () => {
		// Arrange
		const unset = await setUp({ signedIn: false, configured: false })
		const set = await setUp({ signedIn: false })

		// Act
		const missing = await unset.host.missingSettings?.(unset.credentials, abortSignal)
		const none = await set.host.missingSettings?.(set.credentials, abortSignal)

		// Assert
		expect(missing).toEqual([expect.stringContaining(`mesh-flow credential set ${awsCredentialNames.startUrl}`)])
		expect(none).toEqual([])
	})
})
