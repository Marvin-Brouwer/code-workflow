import { microsandboxBackend } from '../../src/microsandbox/microsandbox-backend.ts';
import { describeConformance } from './conformance.ts';

describeConformance('microsandbox', () => microsandboxBackend(), 'node:22-slim');
