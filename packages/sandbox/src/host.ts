import { accessSync, constants } from 'node:fs';

export type KvmAccess = { readonly usable: true } | { readonly usable: false; readonly reason: string };

/** What backend selection needs to know about this machine. */
export interface Host {
    readonly platform: NodeJS.Platform;
    /** Only checked on Linux, where it decides between microsandbox and gVisor. */
    readonly kvm: KvmAccess;
}

/** Looks at this machine: the platform, and on Linux whether `/dev/kvm` can be read and written. */
export function detectHost(): Host {
    return { platform: process.platform, kvm: process.platform === 'linux' ? checkKvm() : { usable: false, reason: 'not Linux' } };
}

function checkKvm(): KvmAccess {
    try {
        accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
        return { usable: true };
    } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : String(error);
        return { usable: false, reason: `/dev/kvm isn't usable (${code})` };
    }
}
