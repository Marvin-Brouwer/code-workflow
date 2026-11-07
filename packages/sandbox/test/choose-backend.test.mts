import { describe, expect, test } from 'vitest'
import { chooseBackend } from '../src/choose-backend.mts'
import type { Host, KvmAccess } from '../src/host.mts'

const noKvm: KvmAccess = { usable: false, reason: "/dev/kvm isn't usable (ENOENT)" }
const linuxWithKvm: Host = { platform: 'linux', arch: 'x64', kvm: { usable: true } }
const linuxWithoutKvm: Host = { platform: 'linux', arch: 'x64', kvm: noKvm }

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

	test('picks microsandbox on Windows', () => {
		// Act
		const choice = chooseBackend({ hosted: false }, { platform: 'win32', arch: 'x64', kvm: noKvm })

		// Assert
		expect(choice.backend).toBe('microsandbox')
		expect(choice.warning).toBeUndefined()
	})

	test('picks microsandbox on Apple Silicon, with a warning that it is untested', () => {
		// Act
		const choice = chooseBackend({ hosted: false }, { platform: 'darwin', arch: 'arm64', kvm: noKvm })

		// Assert
		expect(choice.backend).toBe('microsandbox')
		expect(choice.warning).toMatch(/untested/)
	})

	test('throws on an Intel Mac, saying why', () => {
		// Arrange
		const intelMac: Host = { platform: 'darwin', arch: 'x64', kvm: noKvm }

		// Act
		const choose = () => chooseBackend({ hosted: false }, intelMac)

		// Assert
		expect(choose).toThrow(/Intel Mac: microsandbox only ships for Apple Silicon/)
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
		const freebsd: Host = { platform: 'freebsd', arch: 'x64', kvm: noKvm }

		// Act
		const choose = () => chooseBackend({ hosted: false }, freebsd)

		// Assert
		expect(choose).toThrow(/No sandbox backend runs on freebsd/)
	})
})
