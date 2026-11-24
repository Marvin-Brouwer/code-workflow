import { ShownConnector, SignInState, type ConnectorSetting, type ListedProvider, type ProviderModelList } from '@mesh-flow/engine'
import { CredentialName, MissingSetting } from '@mesh-flow/gateway'
import { describe, expect, expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import * as page from '../../app/src/_shared/settings.mts'

/** What a schema accepts, to compare two written apart. */
function shapeOf(schema: z.ZodType): unknown {
	return z.toJSONSchema(schema, { io: 'output' })
}

describe("the page's copies of the engine's answers", () => {
	test.each([
		['MissingSetting', page.MissingSetting, MissingSetting],
		['ShownConnector', page.ShownConnector, ShownConnector],
		['SignInState', page.SignInState, SignInState],
	])('%s accepts what the original does', (_name, copy, original) => {
		// Act
		const copied = shapeOf(copy)

		// Assert
		expect(copied).toEqual(shapeOf(original))
	})

	test('ProviderModelList takes what the original holds', () => {
		// Arrange
		const listed: ProviderModelList[] = [
			{ source: 'provider', models: [{ id: 'claude-opus-5-5', usable: true }] },
			{ source: 'failed', reason: 'It answered 401.' },
		]

		// Assert
		expect(listed.map((answer) => page.ProviderModelList.safeParse(answer).success)).toEqual([true, true])
	})

	test('ListedProvider and ConnectorPackage take what the originals hold', () => {
		// Assert
		expectTypeOf<ListedProvider>().toExtend<page.ListedProvider>()
		expectTypeOf<ConnectorSetting>().toExtend<page.ConnectorPackage>()
	})
})

describe("the page's credential names", () => {
	test.each(['github/token', 'webhook/fix-issue', 'a.b/c', 'a/./b', 'x/../provider-order', '..', 'no space', ''])(
		'take %j exactly when the gateway does',
		(name) => {
			// Act
			const taken = page.CredentialName.safeParse(name).success

			// Assert
			expect(taken).toBe(CredentialName.safeParse(name).success)
		},
	)
})
