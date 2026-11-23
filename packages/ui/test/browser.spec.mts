import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { duration } from '@mesh-flow/duration'
import { chromium, type Browser } from 'playwright-core'
import { describe, expect, onTestFinished, test } from 'vitest'
import { serveUiFrom } from '../src/_module/server.mts'
import { temporaryDirectory } from './support/served-ui.mts'
import { standInEngine } from './support/stand-in-engine.mts'

/** The page as `pnpm build` makes it: this test runs against the real one. */
const builtPage = fileURLToPath(new URL('../dist/app', import.meta.url))

/** A browser: the one at `CHROMIUM_PATH`, or else the installed Chrome, as CI runners have. */
async function openBrowser(): Promise<Browser> {
	const executablePath = process.env.CHROMIUM_PATH
	const browser = await chromium.launch(executablePath === undefined ? { channel: 'chrome' } : { executablePath })
	onTestFinished(() => browser.close())
	return browser
}

describe.skipIf(process.platform === 'win32')('the page', () => {
	test('starts a run through the wizard, and answers its question as it comes in', async () => {
		// Arrange
		if (!existsSync(builtPage)) throw new Error('Build the page first: pnpm --filter @mesh-flow/ui build')
		const home = await temporaryDirectory()
		await standInEngine(home)
		const stopping = new AbortController()
		const served = await serveUiFrom(builtPage, { home, keychain: false, port: 0, abortSignal: stopping.signal })
		onTestFinished(async () => {
			stopping.abort()
			await served.closed
		})
		const page = await (await openBrowser()).newPage()
		// Fail on the step that hangs, not on the test's own timeout.
		page.setDefaultTimeout(duration.of('10s').to('ms'))

		// Act
		await page.goto(served.url)
		await page.getByText('The app still needs 1 setting before a run can start.').waitFor()
		await page.getByRole('link', { name: 'New run' }).click()
		await page.getByText('Set github/token').waitFor()
		await page.getByLabel('Value').fill('ghp_test')
		await page.getByRole('button', { name: 'Set' }).click()
		await page.getByLabel('issue').fill('63')
		await page.getByRole('button', { name: 'Start' }).click()
		await page.getByText('Which die is wrong?').first().waitFor()
		const startedBar = await page.getByText('Collected issue #63').isVisible()
		const shownMarkup = await page.locator('main').textContent()
		const madeElements = await page.locator('main script, main img').count()
		const ranScript = await page.evaluate(() => 'injected' in globalThis)
		await page.getByLabel('answer').fill('the red one')
		await page.getByRole('button', { name: 'Answer' }).click()

		// Assert
		expect(startedBar).toBe(true)
		expect(shownMarkup).toContain('<script>window.injected = true</script>')
		expect(shownMarkup).toContain('<img src=x onerror="window.injected = true">')
		expect(madeElements).toBe(0)
		expect(ranScript).toBe(false)
		await expect.poll(() => page.locator('dd').first().textContent()).toBe('succeeded')
		await expect.poll(() => page.getByRole('status').filter({ hasText: 'Live' }).count()).toBe(1)
	})
})
