import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as tar from 'tar'

/**
 * Packs the built app in `folder` into a tarball, hands it to `use`, and removes it again, also
 * when `abortSignal` aborts. `use` is bound by its own signal.
 */
export async function withPackedApp<T>(folder: string, use: (tarball: string) => Promise<T>, abortSignal: AbortSignal): Promise<T> {
	abortSignal.throwIfAborted()
	const scratch = await mkdtemp(path.join(tmpdir(), 'mesh-flow-deploy-'))
	try {
		const tarball = path.join(scratch, 'app.tgz')
		await tar.create({ gzip: true, file: tarball, cwd: folder, portable: true }, ['.'])
		abortSignal.throwIfAborted()
		return await use(tarball)
	} finally {
		await rm(scratch, { recursive: true, force: true })
	}
}
