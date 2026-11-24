import { duration } from '@mesh-flow/duration'
import { describe, expect, test, vi } from 'vitest'
import { providerModels } from '../src/providers/provider-models.mts'

const abortSignal = new AbortController().signal

/** A provider of Anthropic's kind, as a config declares it. */
const anthropic = { name: 'anthropic', kind: 'anthropic' }

/** A provider that never answers, whatever its signal says. */
const neverAnswers = () => new Promise<never>(() => undefined)

describe('providerModels', () => {
	test("says the provider didn't answer in time when it never does", async () => {
		// Act
		const listed = await providerModels(
			anthropic,
			{
				key: 'sk-anthropic',
				fetchFromHost: neverAnswers,
				timeout: duration.of('20ms'),
			},
			abortSignal,
		)

		// Assert
		expect(listed).toEqual({ source: 'failed', reason: "Provider anthropic didn't list its models: no answer within 20ms." })
	})

	test("says why when the provider can't be reached", async () => {
		// Act
		const listed = await providerModels(
			anthropic,
			{
				key: 'sk-anthropic',
				fetchFromHost: () => Promise.reject(new TypeError('fetch failed')),
			},
			abortSignal,
		)

		// Assert
		expect(listed).toMatchObject({ source: 'failed', reason: expect.stringContaining('fetch failed') as unknown })
	})

	test('settles when it is stopped, even if the provider never answers', async () => {
		// Arrange
		const sent = vi.fn<typeof fetch>(neverAnswers)
		const stop = new AbortController()
		const listing = providerModels(anthropic, { key: 'sk-anthropic', fetchFromHost: sent }, stop.signal)
		await vi.waitFor(() => {
			expect(sent).toHaveBeenCalled()
		})

		// Act
		stop.abort(new Error('The run stopped.'))

		// Assert
		await expect(listing).rejects.toThrow('The run stopped.')
	})

	test('lets go of the answer of a provider without a model list, and goes by the catalog', async () => {
		// Arrange
		const cancelled = vi.fn()
		const body = new ReadableStream({ cancel: cancelled })
		const sent = vi.fn<typeof fetch>(() => Promise.resolve(new Response(body, { status: 404 })))

		// Act
		const listed = await providerModels(anthropic, { key: 'sk-anthropic', fetchFromHost: sent }, abortSignal)

		// Assert
		expect(listed).toMatchObject({ source: 'catalog' })
		expect(cancelled).toHaveBeenCalledOnce()
	})
})
