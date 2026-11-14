import { microsandboxBackend } from '../../src/microsandbox/microsandbox.backend.mts'
import { describeConformance } from './conformance.mts'

describeConformance('microsandbox', () => microsandboxBackend(), { node: 'node:26-slim', packageManagers: 'node:26-bookworm' })
