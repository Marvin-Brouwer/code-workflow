import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { duration } from '@mesh-flow/duration'
import { chromium, type Browser, type Page } from 'playwright-core'
import { describe, expect, onTestFinished, test } from 'vitest'
import { serveUiFrom } from '../src/_module/server.mts'
import { temporaryDirectory } from './support/served-ui.mts'
import { standInEngine, standInSchedule } from './support/stand-in-engine.mts'

/** The page as `pnpm build` makes it: this test runs against the real one. */
const builtPage = fileURLToPath(new URL('../dist/app', import.meta.url))

/** A browser: the one at `CHROMIUM_PATH`, or else the installed Chrome, as CI runners have. */
async function openBrowser(): Promise<Browser> {
	const executablePath = process.env.CHROMIUM_PATH
	const browser = await chromium.launch(executablePath === undefined ? { channel: 'chrome' } : { executablePath })
	onTestFinished(() => browser.close())
	return browser
}

/** The built page, served against a stand-in engine, in a new browser page. */
async function openUi(): Promise<{ page: Page; url: string }> {
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
	return { page, url: served.url }
}

describe.skipIf(process.platform === 'win32')('the page', () => {
	test('starts a run through the wizard, and answers its question as it comes in', async () => {
		// Arrange
		const { page, url } = await openUi()

		// Act
		await page.goto(url)
		await page.getByText('The app still needs 2 settings before a run can start.').waitFor()
		await page.getByRole('link', { name: 'New run' }).click()
		await page.getByRole('link', { name: 'fix-issue: starts fix-issue' }).click()
		await page.getByLabel('API key of anthropic').fill('sk-test')
		await page.getByRole('button', { name: 'Set key' }).click()
		await page.getByLabel('API key of anthropic').waitFor({ state: 'detached' })
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

	test('sets up what is missing, then hides the bar and shows the triggers', async () => {
		// Arrange
		const { page, url } = await openUi()

		// Act
		await page.goto(url)
		await page.getByRole('link', { name: 'Set them up' }).click()
		await page.getByLabel('API key of anthropic').fill('sk-test')
		await page.getByRole('button', { name: 'Set key' }).click()
		await page.getByLabel('API key of anthropic').waitFor({ state: 'detached' })
		await page.getByLabel('Value').fill('ghp_test')
		await page.getByRole('button', { name: 'Set' }).click()
		await page.getByText('Nothing is missing: every run can start.').waitFor()
		await page.getByRole('link', { name: 'Runs' }).click()
		await page.getByRole('link', { name: 'New run' }).waitFor()
		const barCount = await page.getByText('The app still needs').count()
		await page.getByRole('link', { name: 'Triggers' }).click()
		await page.getByText(standInSchedule).waitFor()
		const startLinks = await page.getByRole('link', { name: 'Start' }).count()
		const webhookDetail = await page.getByRole('row', { name: /issue-opened/ }).textContent()

		// Assert
		expect(barCount).toBe(0)
		expect(startLinks).toBe(2)
		expect(webhookDetail).toContain('No secret: set webhook/issue-opened under credentials')
	})

	test("lists the config's providers without a way to add, move or remove one, and sets and removes a key", async () => {
		// Arrange
		const { page, url } = await openUi()

		// Act
		await page.goto(url)
		await page.goto(new URL('/settings/providers/', url).href)
		const proxyRow = await page.getByRole('row', { name: /proxy/ }).textContent()
		const formFields = await page.getByLabel(/Name|Kind|Base URL/).count()
		const moveButtons = await page.getByRole('button', { name: /Up|Down/ }).count()
		await page
			.getByRole('row', { name: /anthropic/ })
			.locator('summary', { hasText: 'Set key' })
			.click()
		await page.getByLabel('API key of anthropic').fill('sk-test')
		await page.getByRole('button', { name: 'Set key' }).click()
		const removeKey = page.locator('summary', { hasText: 'Remove key' })
		await removeKey.waitFor()
		const keySet = await page.getByRole('row', { name: /anthropic/ }).textContent()
		await removeKey.click()
		await page.getByRole('button', { name: 'Remove the key of anthropic' }).click()
		await removeKey.waitFor({ state: 'detached' })

		// Assert
		expect(proxyRow).toContain('https://llm-proxy.example.com/api/v1')
		expect(proxyRow).toContain('not set')
		expect(formFields).toBe(0)
		expect(moveButtons).toBe(0)
		expect(keySet).not.toContain('not set')
	})
})
