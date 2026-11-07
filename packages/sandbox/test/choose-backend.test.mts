import { describe, expect, test } from 'vitest'
import { chooseBackend } from '../src/choose-backend.mts'
import type { Host } from '../src/host.mts'

const linuxWithKvm: Host = { platform: 'linux', kvm: { usable: true } }
const linuxWithoutKvm: Host = { platform: 'linux', kvm: { usable: false, reason: "/dev/kvm isn't usable (ENOENT)" } }

describe('chooseBackend', () => {
	test('picks E2B for hosted runs', () => {
		// Act
		const choice = chooseBackend({ hosted: true }, linuxWithKvm)

		// Assert
		expect(choice.backend).toBe('e2b')
	})

	test('lets the host configuration force a backend, also when hosted', () => {
		// Act
		const choice = chooseBackend({ hosted: true, force: 'gvisor' }, linuxWithKvm)

		// Assert
		expect(choice).toEqual({ backend: 'gvisor', reason: 'set in the host configuration' })
	})

	test.each([
		['darwin', linuxWithoutKvm.kvm],
		['win32', linuxWithoutKvm.kvm],
	] as const)('picks microsandbox on %s', (platform, kvm) => {
		// Act
		const choice = chooseBackend({ hosted: false }, { platform, kvm })

		// Assert
		expect(choice.backend).toBe('microsandbox')
	})

	test('picks microsandbox on Linux with a usable /dev/kvm', () => {
		// Act
		const choice = chooseBackend({ hosted: false }, linuxWithKvm)

		// Assert
		expect(choice.backend).toBe('microsandbox')
	})

	test('picks gVisor on Linux without /dev/kvm, and says why', () => {
		// Act
		const choice = chooseBackend({ hosted: false }, linuxWithoutKvm)

		// Assert
		expect(choice).toEqual({ backend: 'gvisor', reason: "/dev/kvm isn't usable (ENOENT), so no hypervisor" })
	})

	test('throws on a platform no backend runs on', () => {
		// Assert
		expect(() => chooseBackend({ hosted: false }, { platform: 'freebsd', kvm: linuxWithoutKvm.kvm })).toThrow(
			/No sandbox backend runs on freebsd/,
		)
	})
})
