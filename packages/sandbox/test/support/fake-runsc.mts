import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { forwarderReadyCheck } from '../../src/gvisor/egress-forwarder.mts'
import { Layout } from '../../src/gvisor/layout.mts'
import { imageMarker, rootfsDirectory } from '../../src/gvisor/rootfs.mts'

export interface FakeRunscOptions {
	/** A runsc command that never finishes, such as `run`, for tests of abort and close. */
	readonly hangOn?: string
	/** What the wait for the egress forwarder gets: no init runs here, so nothing really listens. Default `listens`. */
	readonly forwarder?: 'listens' | 'never'
}

/**
 * A stand-in for runsc, for tests on machines without it. It keeps a file per container under
 * `--root` that holds its status, and `exec` runs the command on the host, so a command that never
 * ends really never ends. The wait for the egress forwarder, the command in `readyCheckFile`, is
 * answered as `options.forwarder` says.
 */
function script(options: FakeRunscOptions, readyCheckFile: string): string {
	return `#!/bin/sh
root=
while [ $# -gt 0 ]; do
    case "$1" in
        --root=*) root="\${1#--root=}"; shift ;;
        --*) shift ;;
        *) break ;;
    esac
done
containers="$root/fake-containers"
mkdir -p "$containers"
command="$1"; shift
[ "$command" = "${options.hangOn ?? ''}" ] && exec sleep 3600
for last; do :; done
case "$command" in
    run|restore) echo running > "$containers/$last" ;;
    checkpoint) image="\${1#--image-path=}"; echo memory > "$image/pages.img"; echo stopped > "$containers/$last" ;;
    kill) [ -e "$containers/$1" ] && echo stopped > "$containers/$1" ;;
    delete) rm -f "$containers/$last" ;;
    exec)
        while [ $# -gt 0 ]; do case "$1" in --*) shift ;; *) break ;; esac; done
        shift
        [ "$*" = "$(cat '${readyCheckFile}')" ] && exit ${options.forwarder === 'never' ? '1' : '0'}
        exec "$@" ;;
    list)
        printf '['; separator=
        for file in "$containers"/*; do
            [ -e "$file" ] || continue
            printf '%s{"id":"%s","status":"%s"}' "$separator" "$(basename "$file")" "$(cat "$file")"; separator=,
        done
        printf ']\\n' ;;
esac
`
}

/** Where the fake runsc keeps a container's status, to change it from a test. */
export function fakeContainerFile(directory: string, id: string): string {
	return path.join(new Layout(directory).runscRoot, 'fake-containers', id)
}

/** Writes the fake runsc and an already unpacked image into `directory`. Returns the command. */
export async function fakeRunsc(directory: string, image: string, options: FakeRunscOptions = {}): Promise<string[]> {
	const file = path.join(directory, 'fake-runsc')
	const readyCheckFile = path.join(directory, 'forwarder-ready-check')
	await writeFile(readyCheckFile, forwarderReadyCheck.join(' '))
	await writeFile(file, script(options, readyCheckFile))
	await chmod(file, 0o755)
	const rootfs = rootfsDirectory(path.join(directory, 'images'), image)
	await mkdir(rootfs, { recursive: true })
	await writeFile(path.join(rootfs, imageMarker), JSON.stringify({ image, env: ['PATH=/usr/bin:/bin'], workingDir: '/' }))
	return [file]
}
