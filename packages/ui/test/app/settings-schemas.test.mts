import { ShownConnector, SignInState } from '@mesh-flow/engine'
import { MissingSetting } from '@mesh-flow/gateway'
import { z } from 'zod'
import { describe, expect, test } from 'vitest'
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
})
