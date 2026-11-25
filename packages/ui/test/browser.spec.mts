import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { duration } from '@mesh-flow/duration'
import { chromium, type Browser, type Page } from 'playwright-core'
import { describe, expect, onTestFinished, test } from 'vitest'
import { serveUiFrom } from '../src/_module/server.mts'
import { temporaryDirectory } from './support/served-ui.mts'
import { standInEngine, standInSchedule, type StandInOptions } from './support/stand-in-engine.mts'

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
async function openUi(options: StandInOptions = {}): Promise<{ page: Page; url: string }> {
	if (!existsSync(builtPage)) throw new Error('Build the page first: pnpm --filter @mesh-flow/ui build')
	const home = await temporaryDirectory()
	await standInEngine(home, options)
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

/** Whether the page is scrolled to its bottom, as the run view follows it: run in the page. */
const atBottom = 'window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 48'

describe.skipIf(process.platform === 'win32')('the page', () => {
	test('starts a run through the wizard, and answers its question as it comes in', async () => {
		// Arrange
		const { page, url } = await openUi()
		// Short, so the run's steps don't fit.
		await page.setViewportSize({ width: 1000, height: 300 })

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
		await page.getByLabel('number').fill('63')
		const pinnedRepository = await page.locator('form p', { hasText: 'repository:' }).textContent()
		const repositoryFields = await page.getByLabel('repository').count()
		await page.getByRole('button', { name: 'Start' }).click()
		await page.getByText('Which die is wrong?').first().waitFor()
		const startedBar = await page.getByText('Collected issue octo/dice#63').isVisible()
		const shownMarkup = await page.locator('main').textContent()
		const madeElements = await page.locator('main script, main img').count()
		const ranScript = await page.evaluate(() => 'injected' in globalThis)
		// The input is read on its own, after the run shows.
		const shownInput = await page.locator('h2:text-is("Input") + pre').textContent()
		const liveUsage = await page.getByRole('row', { name: /claude-sonnet-5-5/ }).textContent()
		const liveHeading = await page.getByRole('heading', { name: 'Usage so far' }).count()
		// The steps don't fit, so the page has followed them down.
		await expect.poll(() => page.evaluate(atBottom)).toBe(true)
		await page.getByLabel('answer').fill('the red one')
		await page.getByRole('button', { name: 'Answer' }).click()

		// Assert
		expect(pinnedRepository).toBe('repository: octo/dice')
		expect(repositoryFields).toBe(0)
		expect(startedBar).toBe(true)
		expect(shownMarkup).toContain('<script>window.injected = true</script>')
		expect(shownMarkup).toContain('<img src=x onerror="window.injected = true">')
		expect(madeElements).toBe(0)
		expect(ranScript).toBe(false)
		await expect.poll(() => page.locator('dd').first().textContent()).toBe('succeeded')
		await expect.poll(() => page.getByRole('status').filter({ hasText: 'Live' }).count()).toBe(1)
		await expect.poll(() => page.getByRole('heading', { name: 'Usage', exact: true }).count()).toBe(1)
		expect(JSON.parse(shownInput ?? 'null')).toEqual({ issue: { repository: 'octo/dice', number: 63 } })
		expect(liveHeading).toBe(1)
		expect(liveUsage).toContain('100')
		expect(await page.getByRole('row', { name: /claude-sonnet-5-5/ }).textContent()).toContain('200')
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

	test("lists the config's providers without a way to change them, and links each key to its credential", async () => {
		// Arrange
		const { page, url } = await openUi()

		// Act
		await page.goto(url)
		await page.goto(new URL('/settings/providers/', url).href)
		const proxyRow = await page.getByRole('row', { name: /proxy/ }).textContent()
		const formFields = await page.locator('main input').count()
		const disclosures = await page.locator('main summary').count()
		await page
			.getByRole('row', { name: /anthropic/ })
			.getByRole('link', { name: 'Set key' })
			.click()
		const keyField = page.getByLabel('Value of provider/anthropic')
		await keyField.waitFor()
		const focused = await page.locator('input:focus').getAttribute('aria-label')
		await keyField.fill('sk-test')
		await page.getByRole('button', { name: 'Set provider/anthropic' }).click()
		await page.getByRole('button', { name: 'Clear provider/anthropic' }).waitFor()
		const keyState = await page
			.getByRole('row', { name: /provider\/anthropic/ })
			.getByRole('cell')
			.nth(1)
			.textContent()
		await page.getByRole('link', { name: 'Providers' }).click()
		const changeKey = page.getByRole('row', { name: /anthropic/ }).getByRole('link', { name: 'Change key' })
		await changeKey.waitFor()

		// Assert
		expect(proxyRow).toContain('https://llm-proxy.example.com/api/v1')
		expect(proxyRow).toContain('not set')
		expect(proxyRow).toContain('Listed once it has a key.')
		expect(formFields).toBe(0)
		expect(disclosures).toBe(0)
		expect(focused).toBe('Value of provider/anthropic')
		expect(keyState).toBe('set')
	})

	test('replaces and clears a credential from its row, without opening anything first', async () => {
		// Arrange
		const { page, url } = await openUi()

		// Act
		await page.goto(url)
		await page.goto(new URL('/settings/credentials/', url).href)
		await page.getByLabel('Name').fill('github/token')
		await page.getByLabel('Value', { exact: true }).fill('ghp_first')
		await page.getByRole('button', { name: 'Set', exact: true }).click()
		const newValue = page.getByLabel('Value of github/token')
		await newValue.fill('ghp_second')
		await page.getByRole('button', { name: 'Replace github/token' }).click()
		// The replaced value is taken once the field is emptied.
		await expect.poll(() => newValue.inputValue()).toBe('')
		const generateButtons = await page.getByRole('button', { name: 'Generate' }).count()
		const disclosures = await page.locator('table summary').count()
		await page.getByRole('button', { name: 'Clear github/token' }).click()
		await newValue.waitFor({ state: 'detached' })
		const shown = await page.locator('main table').textContent()

		// Assert
		expect(generateButtons).toBe(1)
		expect(disclosures).toBe(0)
		expect(shown).not.toContain('github/token')
		expect(shown).not.toContain('ghp_')
	})

	test('continues a restartable run and archives a stopped one from the runs list', async () => {
		// Arrange
		const { page, url } = await openUi({ runs: [{ status: 'restartable' }, { status: 'stopped' }] })

		// Act
		await page.goto(url)
		await page.goto(new URL('/runs/', url).href)
		const restartableRow = page.getByRole('row', { name: /run-f00000000001/ })
		const stoppedRow = page.getByRole('row', { name: /run-f00000000002/ })
		const restartableButtons = await restartableRow.getByRole('button').allTextContents()
		const stoppedButtons = await stoppedRow.getByRole('button').allTextContents()
		await page.getByRole('button', { name: 'Continue run-f00000000001' }).click()
		await expect.poll(() => restartableRow.textContent()).toContain('starting')
		await page.getByRole('button', { name: 'Archive run-f00000000002' }).click()
		await stoppedRow.waitFor({ state: 'detached' })
		await page.getByLabel('Show archived runs').check()
		await page.getByRole('button', { name: 'Unarchive run-f00000000002' }).waitFor()
		const archivedRows = await page.getByRole('row', { name: /run-f0/ }).allTextContents()
		await page.getByRole('button', { name: 'Unarchive run-f00000000002' }).click()
		await page.getByText('No archived runs.').waitFor()

		// Assert
		expect(restartableButtons).toEqual(['Continue'])
		expect(stoppedButtons).toEqual(['Continue', 'Archive'])
		expect(archivedRows).toHaveLength(1)
		expect(archivedRows[0]).toContain('run-f00000000002')
	})

	test('asks before continuing a run on an older build, and continues it only on yes', async () => {
		// Arrange
		const { page, url } = await openUi({ runs: [{ status: 'stopped', version: 'v0' }] })

		// Act
		await page.goto(url)
		await page.goto(new URL('/runs/', url).href)
		const row = page.getByRole('row', { name: /run-f00000000001/ })
		const dialog = page.getByRole('dialog')
		await page.getByRole('button', { name: 'Continue run-f00000000001' }).click()
		const question = await dialog.textContent()
		await dialog.getByRole('button', { name: 'Cancel' }).click()
		await dialog.waitFor({ state: 'detached' })
		const afterCancel = await row.textContent()
		await page.getByRole('button', { name: 'Continue run-f00000000001' }).click()
		await dialog.getByRole('button', { name: 'Continue' }).click()

		// Assert
		expect(question).toContain('build v0')
		expect(question).toContain('build v1 is deployed')
		expect(afterCancel).toContain('stopped')
		await expect.poll(() => row.textContent()).toContain('starting')
	})

	test('shows a tail button once someone scrolls up, which follows the newest steps again', async () => {
		// Arrange
		const { page, url } = await openUi({ runs: [{ status: 'stopped' }] })
		// Short, so the run page doesn't fit.
		await page.setViewportSize({ width: 1000, height: 200 })
		const tail = page.getByRole('button', { name: 'Tail' })

		// Act
		await page.goto(url)
		await page.goto(new URL('/runs/run-f00000000001/', url).href)
		await expect.poll(() => page.evaluate(atBottom)).toBe(true)
		const shownWhileFollowing = await tail.isVisible()
		await page.evaluate('window.scrollTo(0, 0)')
		await tail.waitFor()
		await tail.click()

		// Assert
		expect(shownWhileFollowing).toBe(false)
		await expect.poll(() => page.evaluate(atBottom)).toBe(true)
		await expect.poll(() => tail.isVisible()).toBe(false)
	})

	test("keeps what's typed in one row while another credential is set, and clears a provider's key back to not set", async () => {
		// Arrange
		const { page, url } = await openUi()

		// Act
		await page.goto(url)
		await page.goto(new URL('/settings/credentials/', url).href)
		const keyField = page.getByLabel('Value of provider/anthropic')
		await keyField.fill('sk-typing')
		await page.getByLabel('Name').fill('github/token')
		await page.getByLabel('Value', { exact: true }).fill('ghp_first')
		await page.getByRole('button', { name: 'Set', exact: true }).click()
		await page.getByRole('button', { name: 'Clear github/token' }).waitFor()
		const typed = await keyField.inputValue()
		await page.getByRole('button', { name: 'Set provider/anthropic' }).click()
		await page.getByRole('button', { name: 'Clear provider/anthropic' }).click()
		await page.getByRole('button', { name: 'Clear provider/anthropic' }).waitFor({ state: 'detached' })
		const keyState = await page
			.getByRole('row', { name: /provider\/anthropic/ })
			.getByRole('cell')
			.nth(1)
			.textContent()

		// Assert
		expect(typed).toBe('sk-typing')
		expect(keyState).toBe('not set')
	})
})
