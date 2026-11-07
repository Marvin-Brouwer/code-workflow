/**
 * Waits inside the sandbox until the outbox has more lines than the engine has read, then prints
 * the new ones. Plain POSIX shell, so nothing has to be copied into the sandbox for it.
 *
 * Arguments: the outbox, the runtime's pid file, the number of lines already read, and how many
 * quarter seconds to wait at most. Exits 0 with the new lines (or none, when the wait ran out),
 * and 3 when the runtime is gone and has nothing more to say. A zombie counts as gone.
 */
export const pollScript = `
outbox=$1 pidFile=$2 after=$3 tries=$4
lines() { if [ -f "$outbox" ]; then wc -l < "$outbox"; else echo 0; fi; }
alive() {
	[ -f "$pidFile" ] || return 0
	state=$(cut -d ' ' -f 3 "/proc/$(cat "$pidFile")/stat" 2>/dev/null) || return 1
	[ "$state" != Z ] && [ "$state" != X ]
}
i=0
while [ "$(lines)" -le "$after" ]; do
	if ! alive; then
		[ "$(lines)" -le "$after" ] && exit 3
		break
	fi
	[ "$i" -ge "$tries" ] && exit 0
	sleep 0.25
	i=$((i + 1))
done
tail -n "+$((after + 1))" "$outbox"
`

/** The exit code of {@link pollScript} when the runtime is gone. */
export const runtimeGoneExitCode = 3
