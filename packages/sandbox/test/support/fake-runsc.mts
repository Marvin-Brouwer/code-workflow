import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { rootfsDirectory } from '../../src/gvisor/rootfs.mts'

/**
 * A stand-in for runsc, for tests on machines without it. It keeps a marker file per running
 * container under `--root`, and `exec` runs the command on the host, so a command that never
 * ends really never ends.
 */
const script = `#!/bin/sh
root=
while [ $# -gt 0 ]; do
    case "$1" in
        --root=*) root="\${1#--root=}"; shift ;;
        --*) shift ;;
        *) break ;;
    esac
done
running="$root/fake-running"
mkdir -p "$running"
command="$1"; shift
for last; do :; done
case "$command" in
    run|restore) touch "$running/$last" ;;
    checkpoint) image="\${1#--image-path=}"; echo memory > "$image/pages.img"; rm -f "$running/$last" ;;
    kill) rm -f "$running/$1" ;;
    delete) rm -f "$running/$last" ;;
    exec)
        while [ $# -gt 0 ]; do case "$1" in --*) shift ;; *) break ;; esac; done
        shift
        exec "$@" ;;
    list)
        printf '['; separator=
        for file in "$running"/*; do
            [ -e "$file" ] || continue
            printf '%s{"id":"%s","status":"running"}' "$separator" "$(basename "$file")"; separator=,
        done
        printf ']\\n' ;;
esac
`

/** Writes the fake runsc and an already unpacked image into `directory`. Returns the command. */
export async function fakeRunsc(directory: string, image: string): Promise<string[]> {
	const file = path.join(directory, 'fake-runsc')
	await writeFile(file, script)
	await chmod(file, 0o755)
	const rootfs = rootfsDirectory(path.join(directory, 'images'), image)
	await mkdir(rootfs, { recursive: true })
	await writeFile(path.join(rootfs, '.mesh-flow-image'), `${image}\n`)
	return [file]
}
