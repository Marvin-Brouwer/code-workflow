import path from 'node:path'
import { keyFile, openCredentialStore, type HostToolContext } from '@mesh-flow/gateway'
import { describe, expect, test } from 'vitest'
import { readSite, tokenCredential, urlCredential } from '../src/host/site.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

/** A host call's context whose credential store holds `stored`. */
async function contextWith(stored: Record<string, string>): Promise<HostToolContext> {
	const home = await temporaryDirectory()
	const credentials = openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
	const abortSignal = new AbortController().signal
	for (const [name, value] of Object.entries(stored)) await credentials.set(name, value, abortSignal)
	return { abortSignal, runId: 'run-1', credentials }
}

describe('readSite', () => {
	test('goes to gitlab.com when no URL is set', async () => {
		expect(await readSite(await contextWith({ [tokenCredential]: 'glpat-1' }))).toEqual({ url: 'https://gitlab.com', token: 'glpat-1' })
	})

	test('takes a GitLab of your own, without the slash at the end', async () => {
		const site = await readSite(await contextWith({ [tokenCredential]: 'glpat-1', [urlCredential]: 'https://gitlab.example.com/' }))
		expect(site.url).toBe('https://gitlab.example.com')
	})

	test('says how to set the token when there is none, and what is wrong with a URL that is none', async () => {
		await expect(readSite(await contextWith({}))).rejects.toThrow('mesh-flow credential set gitlab/token')
		await expect(readSite(await contextWith({ [tokenCredential]: 'glpat-1', [urlCredential]: 'gitlab.example.com' }))).rejects.toThrow(
			"isn't a URL",
		)
	})
})
