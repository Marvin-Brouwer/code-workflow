import { microsandboxBackend } from '../../src/microsandbox/microsandbox.backend.mts'
import { describeConformance } from './conformance.mts'

describeConformance('microsandbox', () => microsandboxBackend(), 'node:22-slim', 'node:22-bookworm')
