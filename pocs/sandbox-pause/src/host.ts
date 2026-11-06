/**
 * Picks the local sandbox backend the way the engine would, then runs the shared pause checks on
 * it: microsandbox where a hypervisor is usable, gVisor otherwise. See ../README.md.
 */
import { accessSync, constants } from 'node:fs';
import { main } from '@pocs/pause-harness';

export type LocalBackend = 'microsandbox' | 'gvisor';

export interface Choice {
    backend: LocalBackend;
    reason: string;
}

/**
 * microsandbox needs a hypervisor: KVM on Linux, Hypervisor.framework on macOS, the Windows
 * Hypervisor Platform on Windows. gVisor needs none, but only runs on Linux. `POC_SANDBOX` forces
 * one.
 */
export function chooseLocalBackend(): Choice {
    const forced = process.env.POC_SANDBOX;
    if (forced === 'microsandbox' || forced === 'gvisor') return { backend: forced, reason: 'POC_SANDBOX' };
    if (forced) throw new Error(`POC_SANDBOX must be microsandbox or gvisor, not '${forced}'`);
    if (process.platform === 'darwin') return { backend: 'microsandbox', reason: 'macOS has Hypervisor.framework' };
    if (process.platform === 'win32') return { backend: 'microsandbox', reason: 'Windows: gVisor has no Windows build' };
    try {
        accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
        return { backend: 'microsandbox', reason: '/dev/kvm is readable and writable' };
    } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : String(error);
        return { backend: 'gvisor', reason: `/dev/kvm isn't usable (${code})` };
    }
}

const choice = chooseLocalBackend();
console.log(`     backend: ${choice.backend} (${choice.reason})`);
const command = process.argv[2] ?? 'run';
// Each backend keeps its own paused state, so `resume` finds a pause only with the backend that made it.
if (choice.backend === 'microsandbox') {
    const { backend, pocDir } = await import('@pocs/microsandbox-pause/backend');
    await main(backend, pocDir, command);
} else {
    const { backend, pocDir } = await import('@pocs/gvisor-pause/backend');
    await main(backend, pocDir, command);
}
