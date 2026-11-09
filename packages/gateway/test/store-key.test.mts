import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { storeKeyBytes } from '../src/credentials/sealed-file.mts'
import { credentialsFileName, defaultStoreKey, keyFile, type StoreKey } from '../src/credentials/store-key.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

/** A keychain that fails, as a locked one does. */
function lockedKeychain(): StoreKey {
	return { where: 'a locked keychain', read: () => Promise.reject(new Error('locked')) }
}

describe('keyFile', () => {
	test('makes a key on first use, readable by its owner only, and gives the same one after', async () => {
		// Arrange
		const file = path.join(await temporaryDirectory(), 'keys', 'store.key')

		// Act
		const first = await keyFile(file).read(abortSignal)
		const second = await keyFile(file).read(abortSignal)

		// Assert
		expect(first).toHaveLength(storeKeyBytes)
		expect(second.equals(first)).toBe(true)
		// Windows has no POSIX modes; the file is in the user's own profile there.
		if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
	})

	test("refuses a key file that isn't a key", async () => {
		// Arrange
		const file = path.join(await temporaryDirectory(), 'store.key')
		await writeFile(file, 'short')

		// Act
		const reading = keyFile(file).read(abortSignal)

		// Assert
		await expect(reading).rejects.toThrow(`isn't ${String(storeKeyBytes)} bytes`)
	})
})

describe('defaultStoreKey', () => {
	test('keeps using a key file once there is one', async () => {
		// Arrange
		const home = await temporaryDirectory()
		await keyFile(path.join(home, 'store.key')).read(abortSignal)

		// Act
		const key = await defaultStoreKey(home, abortSignal)

		// Assert
		expect(key.where).toBe(path.join(home, 'store.key'))
	})

	test('refuses to start a key file when the keychain fails and the credentials are sealed already', async () => {
		// Arrange
		const home = await temporaryDirectory()
		await writeFile(path.join(home, credentialsFileName), 'sealed')

		// Act
		const opening = defaultStoreKey(home, abortSignal, { keychainKey: lockedKeychain })

		// Assert
		await expect(opening).rejects.toThrow("can't be read: locked")
	})

	test('starts a key file when the keychain fails before anything is sealed', async () => {
		// Arrange
		const home = await temporaryDirectory()

		// Act
		const key = await defaultStoreKey(home, abortSignal, { keychainKey: lockedKeychain })

		// Assert
		expect(key.where).toBe(path.join(home, 'store.key'))
	})

	test('gives two first readers at once the same key', async () => {
		// Arrange
		const file = path.join(await temporaryDirectory(), 'store.key')

		// Act
		const [first, second] = await Promise.all([keyFile(file).read(abortSignal), keyFile(file).read(abortSignal)])

		// Assert
		expect(first.equals(second)).toBe(true)
	})
})
