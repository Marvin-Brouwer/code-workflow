import { describe, expect, test } from 'vitest'
import { importServeUi } from '../src/ui/ui-host.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

describe('importServeUi', () => {
	test("says how to install the UI when it isn't there", async () => {
		// Arrange
		const directory = await temporaryDirectory()

		// Act
		const importing = importServeUi(directory)

		// Assert
		await expect(importing).rejects.toThrow('add it with `pnpm add @mesh-flow/ui`')
	})
})
