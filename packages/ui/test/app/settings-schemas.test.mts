import { ShownConnector, SignInState, type ConnectorSetting, type ListedProvider } from '@mesh-flow/engine'
import { CredentialName, knownKinds, MissingSetting, ProviderName } from '@mesh-flow/gateway'
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

	test('ProviderKind reads every kind the gateway knows', () => {
		// Act
		const parsed = z.array(page.ProviderKind).safeParse(knownKinds())

		// Assert
		expect(parsed.success).toBe(true)
	})

	test('ListedProvider and ConnectorPackage take what the originals hold', () => {
		// Assert
		expectTypeOf<ListedProvider>().toExtend<page.ListedProvider>()
		expectTypeOf<ConnectorSetting>().toExtend<page.ConnectorPackage>()
	})
})

describe("the provider form's name pattern", () => {
	test.each(['anthropic', 'work-2', 'a_b', '0', 'Anthropic', '-lead', 'with space', '', 'a'.repeat(64), 'a'.repeat(65)])(
		'takes %j exactly when the gateway does',
		(name) => {
			// Act
			const matches = new RegExp(`^(?:${page.providerNamePattern})$`, 'v').test(name)

			// Assert
			expect(matches).toBe(ProviderName.safeParse(name).success)
		},
	)
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
