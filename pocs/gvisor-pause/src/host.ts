/** Runs the shared pause checks against this backend. See ../README.md. */
import { main } from '@pocs/pause-harness';
import { backend, pocDir } from './backend.js';

await main(backend, pocDir, process.argv[2] ?? 'run');
