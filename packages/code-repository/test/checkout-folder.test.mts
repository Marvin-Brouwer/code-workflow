import { describe, expect, test } from 'vitest'
import { checkoutFolder } from '../src/checkout/checkout-folder.mts'

describe('checkoutFolder', () => {
	test('puts a checkout under repositories/ at its whole name in lower case', () => {
		// Act
		const folder = checkoutFolder('Team/Backend/API')

		// Assert
		expect(folder).toBe('repositories/team/backend/api')
	})

	test('gives a name Windows takes as a device a folder it can make, the same on every platform', () => {
		// Act
		const folders = [checkoutFolder('team/aux'), checkoutFolder('team/con.api'), checkoutFolder('team/api.')]

		// Assert
		expect(folders).toEqual(['repositories/team/aux-', 'repositories/team/con.api-', 'repositories/team/api.-'])
	})
})
