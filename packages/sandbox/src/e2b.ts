/**
 * The E2B backend, for hosted runs. Imported separately, so a local engine never loads the E2B SDK.
 *
 * @module
 */
export { e2bBackend, type E2bBackendOptions } from './e2b/e2b-backend.ts';
