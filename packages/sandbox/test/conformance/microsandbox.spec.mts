import { microsandboxBackend } from '../../src/microsandbox/microsandbox.backend.mts'
import { describeConformance } from './conformance.mts'

describeConformance('microsandbox', () => microsandboxBackend(), { node: 'node:22-slim', packageManagers: 'node:22-bookworm' })
