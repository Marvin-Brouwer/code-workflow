import { describe, expect, test } from 'vitest'
import { chooseBackend } from '../src/choose-backend.mts'
import type { Host, KvmAccess } from '../src/host.mts'

const noKvm: KvmAccess = { usable: false, reason: "/dev/kvm isn't usable (ENOENT)" }
const linuxWithKvm: Host = { platform: 'linux', kvm: { usable: true } }
const linuxWithoutKvm: Host = { platform: 'linux', kvm: noKvm }

describe('chooseBackend', () => {
	test('picks E2B for hosted runs', () => {
		// Act
		const choice = chooseBackend({ hosted: true }, linuxWithKvm)

		// Assert
		expect(choice.backend).toBe('e2b')
	})

	test('lets the host configuration name a backend, also when hosted', () => {
		// Act
		const choice = chooseBackend({ hosted: true, backend: 'gvisor' }, linuxWithKvm)

		// Assert
		expect(choice).toEqual({ backend: 'gvisor', reason: 'set in the host configuration' })
	})

	test.each(['darwin', 'win32'] as const)('picks microsandbox on %s', (platform) => {
		// Act
		const choice = chooseBackend({ hosted: false }, { platform, kvm: noKvm })

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
		// Arrange
		const freebsd: Host = { platform: 'freebsd', kvm: noKvm }

		// Act
		const choose = () => chooseBackend({ hosted: false }, freebsd)

		// Assert
		expect(choose).toThrow(/No sandbox backend runs on freebsd/)
	})
})
