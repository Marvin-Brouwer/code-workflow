import { tmpdir } from 'node:os'
import path from 'node:path'
import { gvisorBackend } from '../../src/gvisor/gvisor-backend.mts'
import { describeConformance } from './conformance.mts'

// RUNSC='sudo runsc' when the tests don't run as root. MESH_FLOW_GVISOR_DIRECTORY keeps the
// unpacked image between runs.
describeConformance(
	'gvisor',
	() =>
		gvisorBackend({
			directory: process.env.MESH_FLOW_GVISOR_DIRECTORY ?? path.join(tmpdir(), 'mesh-flow-gvisor-conformance'),
			runsc: (process.env.RUNSC ?? 'runsc').split(' ').filter(Boolean),
			...(process.env.HTTPS_PROXY === undefined ? {} : { upstreamProxy: process.env.HTTPS_PROXY }),
		}),
	'node:22-slim',
)
