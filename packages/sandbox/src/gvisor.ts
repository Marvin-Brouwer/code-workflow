/**
 * The gVisor backend, for local runs on Linux without a hypervisor, such as CI.
 *
 * @module
 */
export { gvisorBackend, type GvisorBackendOptions } from './gvisor/gvisor-backend.ts';
