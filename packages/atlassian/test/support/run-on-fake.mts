import { atlassianHostTools, defaultRequestRetry } from '../../src/_module/host.mts'
import { fakeAtlassian, type FakeIssue, type FakePage, type FakeUser } from './fake-atlassian.mts'
import { runOnGateway, testGateway } from './test-run.mts'

/** Retries as the connector's own, without the waits, so a test of a site in trouble takes no time. */
export const quickRetry = { ...defaultRequestRetry, initialDelayMs: 1, backoffFactor: 1 }

/** What the fake holds before a run. */
export interface Arrangement {
	readonly issues?: readonly FakeIssue[]
	readonly pages?: readonly FakePage[]
	readonly failNext?: readonly number[]
	readonly losesAnswers?: readonly string[]
	readonly latencyMs?: number
	readonly users?: Readonly<Record<string, FakeUser>>
}

/**
 * Runs `body` on a gateway with `settings`, against a fake holding `arrangement`, and returns the
 * fake, the started run and its result.
 */
export async function runOnFake<T>(settings: Readonly<Record<string, string>>, arrangement: Arrangement, body: () => Promise<T>) {
	const fake = fakeAtlassian()
	for (const issue of arrangement.issues ?? []) fake.issues.set(issue.key, issue)
	for (const page of arrangement.pages ?? []) fake.pages.set(page.id, page)
	fake.failNext.push(...(arrangement.failNext ?? []))
	for (const request of arrangement.losesAnswers ?? []) fake.losesAnswers.add(request)
	fake.latencyMs = arrangement.latencyMs ?? 0
	for (const [id, user] of Object.entries(arrangement.users ?? {})) fake.users.set(id, user)
	const gateway = await testGateway(atlassianHostTools({ fetch: fake.fetch, retry: quickRetry }), settings)
	const started = await runOnGateway(gateway, body)
	return { fake, started, result: await started.result }
}
